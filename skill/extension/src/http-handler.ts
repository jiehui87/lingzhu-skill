import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingzhuConfig, LingzhuContext, LingzhuRequest, LingzhuSSEData } from "./types.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  createFollowUpResponse,
  createQuizStatusResponse,
  createContinuousStatusResponse,
  detectIntentFromText,
  isVisualIntent,
  isQuizIntent,
  extractFollowUpFromText,
  formatLingzhuSSE,
  lingzhuToOpenAI,
  parseToolCallFromAccumulated,
  ToolCallAccumulator,
} from "./transform.js";
import { buildRequestLogName, summarizeForDebug, writeDebugLog } from "./debug-log.js";
import { cleanupImageCacheIfNeeded, ensureImageCacheDir } from "./image-cache.js";
import { lingzhuEventBus, getSessionManager } from "./events.js";

interface LingzhuRuntimeState {
  config: LingzhuConfig;
  authAk: string;
  gatewayPort: number;
  chatCompletionsEnabled?: boolean;
}

interface ValidatedRemoteImageUrl {
  url: URL;
  address: string;
  family: number;
}

const REMOTE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_IMAGE_TIMEOUT_MS = 15000;

// 视觉意图关键词
const VISUAL_INTENT_KEYWORDS = [
  /这是什么/i, /这是啥/i, /看下这个/i, /看看这个/i, 
  /帮我看下/i, /看一下/i, /这是什么东西/i, /识别一下/i,
  /前面有什么/i, /周围有什么/i, /看看前面/i, /看看周围/i,
  /拍一下/i, /照一下/i, /拍张照片/i, /拍个照/i,
  /分析一下/i, /帮我看看/i, /看下是什么/i,
  /你这是什么/i, /看下这个/i, /给我看/i,
];

function resolveMaxImageBytes(config: LingzhuConfig): number {
  if (typeof config.maxImageBytes === "number" && Number.isFinite(config.maxImageBytes)) {
    return Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Math.trunc(config.maxImageBytes)));
  }
  return 5 * 1024 * 1024;
}

function normalizeContext(metadata: LingzhuRequest["metadata"]): LingzhuContext | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  if ("context" in metadata && metadata.context && typeof metadata.context === "object") {
    return metadata.context as LingzhuContext;
  }
  return metadata as LingzhuContext;
}

function extractFallbackUserText(messages: LingzhuRequest["message"]): string {
  return messages
    .map((message) => message.text || message.content || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildSessionKey(config: LingzhuConfig, body: LingzhuRequest): string {
  const namespace = config.sessionNamespace || "lingzhu";
  const targetAgentId = config.agentId || body.agent_id || "main";
  const userId = body.user_id || body.agent_id || "anonymous";

  // 连续/答题模式使用特殊 key
  if (body.keep_alive || body.mode === "continuous" || body.mode === "quiz") {
    return `agent:${targetAgentId}:${namespace}_continuous_${userId}`;
  }
  return `agent:${targetAgentId}:${namespace}_${userId}`;
}

function verifyAuth(authHeader: string | string[] | undefined, expectedAk: string): boolean {
  if (!expectedAk) return true;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header) return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1].trim() === expectedAk;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

async function downloadImageToFile(imageUrl: string, maxBytes: number): Promise<string | null> {
  try {
    const validatedUrl = await validateRemoteImageUrl(imageUrl);
    if (!validatedUrl) return null;
    const response = await requestValidatedRemoteImage(validatedUrl);
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      return null;
    }
    const contentLength = Number(readHeaderValue(response.headers["content-length"]) || "0");
    if (contentLength > maxBytes) {
      response.resume();
      return null;
    }
    const contentType = readHeaderValue(response.headers["content-type"]).toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      response.resume();
      return null;
    }
    const ext = contentType.includes("png") ? ".png"
      : contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg"
      : contentType.includes("gif") ? ".gif"
      : contentType.includes("webp") ? ".webp"
      : ".img";
    const cacheDir = await ensureImageCacheDir();
    const hash = crypto.createHash("md5").update(imageUrl).digest("hex").slice(0, 12);
    const fileName = `img_${Date.now()}_${hash}${ext}`;
    const filePath = path.join(cacheDir, fileName);
    const fileStream = createWriteStream(filePath, { flags: "wx" });
    let totalBytes = 0;
    let completed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          response.destroy();
          fileStream.destroy();
          reject(error);
        };
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            fail(new Error("image exceeds size limit"));
            return;
          }
          if (!fileStream.write(chunk)) {
            response.pause();
            fileStream.once("drain", () => response.resume());
          }
        });
        response.on("end", () => {
          if (settled) return;
          fileStream.end(() => {
            settled = true;
            resolve();
          });
        });
        response.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
        fileStream.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      });
      completed = true;
    } finally {
      if (!completed) {
        fileStream.destroy();
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
    return `file://${filePath}`;
  } catch {
    return null;
  }
}

async function saveDataUrlToFile(dataUrl: string, maxBytes: number): Promise<string | null> {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const payload = match[2].replace(/\s+/g, "");
  if (estimateBase64DecodedBytes(payload) > maxBytes) return null;
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length > maxBytes) return null;
  const ext = mimeType.includes("png") ? ".png"
    : mimeType.includes("jpeg") || mimeType.includes("jpg") ? ".jpg"
    : mimeType.includes("gif") ? ".gif"
    : mimeType.includes("webp") ? ".webp"
    : ".img";
  const cacheDir = await ensureImageCacheDir();
  const hash = crypto.createHash("md5").update(payload).digest("hex").slice(0, 12);
  const fileName = `img_${Date.now()}_${hash}${ext}`;
  const filePath = path.join(cacheDir, fileName);
  await fs.writeFile(filePath, buffer);
  return `file://${filePath}`;
}

function estimateBase64DecodedBytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isPrivateIpv4(address);
  if (ipVersion === 6) return isPrivateIpv6(address);
  return false;
}

async function validateRemoteImageUrl(imageUrl: string): Promise<ValidatedRemoteImageUrl | null> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return null;
  }
  if (!REMOTE_IMAGE_PROTOCOLS.has(parsedUrl.protocol)) return null;
  if (parsedUrl.username || parsedUrl.password) return null;
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname)) return null;
  try {
    const resolved = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
    const safeEntry = resolved.find((entry) => !isPrivateAddress(entry.address));
    if (!safeEntry || resolved.some((entry) => isPrivateAddress(entry.address))) return null;
    return { url: parsedUrl, address: safeEntry.address, family: safeEntry.family };
  } catch {
    return null;
  }
}

async function requestValidatedRemoteImage(target: ValidatedRemoteImageUrl): Promise<http.IncomingMessage> {
  const client = target.url.protocol === "https:" ? https : http;
  const defaultPort = target.url.protocol === "https:" ? 443 : 80;
  const port = target.url.port ? Number(target.url.port) : defaultPort;
  const hostHeader = target.url.port ? `${target.url.hostname}:${target.url.port}` : target.url.hostname;
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: target.url.protocol,
        host: target.address,
        port,
        method: "GET",
        path: `${target.url.pathname}${target.url.search}`,
        headers: { Host: hostHeader, "User-Agent": "openclaw-lingzhu/1.0" },
        family: target.family,
        servername: target.url.protocol === "https:" ? target.url.hostname : undefined,
        lookup: (_hostname, _options, callback) => { callback(null, target.address, target.family); },
        checkServerIdentity: target.url.protocol === "https:" ? (_hostname, cert) => tls.checkServerIdentity(target.url.hostname, cert) : undefined,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          reject(new Error("redirect not allowed"));
          return;
        }
        resolve(response);
      }
    );
    request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => { request.destroy(new Error("remote image timeout")); });
    request.on("error", reject);
    request.end();
  });
}

function isPathWithinDirectory(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveTrustedFileUrl(fileUrl: string): Promise<string | null> {
  try {
    const cacheDir = await ensureImageCacheDir();
    const localPath = fileURLToPath(fileUrl);
    return isPathWithinDirectory(localPath, cacheDir) ? localPath : null;
  } catch {
    return null;
  }
}

async function preprocessOpenAIMessages(
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: string; image_url?: { url: string }; text?: string }>;
  }>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  maxImageBytes: number
): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let hasImage = false;
  
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }
    const textParts: string[] = [];
    const imagePaths: string[] = [];
    
    for (const part of msg.content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "image_url" && part.image_url?.url) {
        hasImage = true;
        const imagePartUrl = part.image_url.url;
        if (imagePartUrl.startsWith("file://")) {
          const localPath = await resolveTrustedFileUrl(imagePartUrl);
          if (localPath) {
            imagePaths.push(localPath);
          } else {
            logger.warn("[Lingzhu] 已拒绝非缓存目录 file URL");
          }
        } else if (imagePartUrl.startsWith("data:")) {
          const fileUrl = await saveDataUrlToFile(imagePartUrl, maxImageBytes);
          if (fileUrl) {
            imagePaths.push(fileUrl.replace("file://", ""));
            logger.info("[Lingzhu] data URL 图片已保存到本地缓存");
          } else {
            logger.warn("[Lingzhu] data URL 图片处理失败或超出大小限制");
          }
        } else {
          logger.info(`[Lingzhu] 正在下载图片到本地: ${imagePartUrl.substring(0, 80)}...`);
          const fileUrl = await downloadImageToFile(imagePartUrl, maxImageBytes);
          if (fileUrl) {
            imagePaths.push(fileUrl.replace("file://", ""));
            logger.info(`[Lingzhu] 图片已保存到: ${fileUrl}`);
          } else {
            logger.warn(`[Lingzhu] 图片下载失败或地址被拒绝: ${imagePartUrl}`);
          }
        }
      }
    }
    
    let finalContent = textParts.join("\n");
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map((imagePath) => `[图片: ${imagePath}]`).join("\n");
      if (finalContent) {
        finalContent = `${finalContent}\n\n${imageRefs}`;
      } else {
        finalContent = `请分析这张图片：\n\n${imageRefs}`;
      }
      logger.info(`[Lingzhu] 已处理 ${imagePaths.length} 张图片`);
    }
    if (finalContent) {
      result.push({ role: msg.role, content: finalContent });
    }
  }
  
  if (hasImage) {
    logger.info(`[Lingzhu] 检测到图片输入，已转换格式`);
  }
  
  return result;
}

// 检测是否为视觉意图
function hasVisualIntent(text: string): boolean {
  return VISUAL_INTENT_KEYWORDS.some(keyword => keyword.test(text));
}

// 处理答题模式自动拍照
async function handleQuizModeAutoCapture(
  sessionKey: string,
  safeWrite: (payload: string) => boolean,
  messageId: string,
  agentId: string,
  logger: { info: (msg: string) => void }
): Promise<void> {
  logger.info(`[Lingzhu:QuizMode] 触发自动拍照`);
  
  // 发送拍照命令
  const captureToolCall: LingzhuSSEData = {
    role: "agent",
    type: "tool_call",
    message_id: messageId,
    agent_id: agentId,
    is_finish: false,
    tool_call: {
      handling_required: true,
      command: "capture_and_read",
      is_recall: true,
      capture_config: { ocr_enabled: true },
    },
  };
  
  safeWrite(formatLingzhuSSE("message", captureToolCall));
  
  // 发送答题模式状态
  const quizStatus = createQuizStatusResponse(
    { is_active: true, capture_count: 0, max_captures: 10 },
    messageId,
    agentId
  );
  safeWrite(formatLingzhuSSE("message", quizStatus));
}

export function createHttpHandler(api: any, getRuntimeState: () => LingzhuRuntimeState) {
  const sessionManager = getSessionManager(getRuntimeState().config);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/metis/agent/api/health" && req.method === "GET") {
      const state = getRuntimeState();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: true,
        endpoint: "/metis/agent/api/sse",
        enabled: state.config.enabled !== false,
        agentId: state.config.agentId || "main",
        supportedCommands: state.config.enableExperimentalNativeActions === true
          ? ["take_photo", "take_navigation", "control_calendar", "notify_agent_off", "send_notification", "send_toast", "speak_tts", "start_video_record", "stop_video_record", "open_custom_view", "enter_quiz_mode", "exit_quiz_mode", "capture_and_read", "enable_continuous_mode", "disable_continuous_mode"]
          : ["take_photo", "take_navigation", "control_calendar", "notify_agent_off"],
        followUpEnabled: state.config.enableFollowUp !== false,
        sessionMode: state.config.sessionMode || "per_user",
        debugLogging: state.config.debugLogging === true,
        experimentalNativeActions: state.config.enableExperimentalNativeActions === true,
        chatCompletionsEnabled: state.chatCompletionsEnabled === true,
        continuousModeEnabled: state.config.enableContinuousMode !== false,
        quizModeEnabled: state.config.enableQuizMode !== false,
      }));
      return true;
    }

    if (url.pathname !== "/metis/agent/api/sse") return false;
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return true;
    }

    const logger = api.logger;
    const state = getRuntimeState();
    const config = state.config;
    const upstreamController = new AbortController();
    let keepaliveInterval: NodeJS.Timeout | undefined;

    const stopKeepalive = () => {
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = undefined;
      }
    };

    const safeWrite = (payload: string): boolean => {
      if (res.writableEnded || res.destroyed) return false;
      try {
        res.write(payload);
        return true;
      } catch {
        return false;
      }
    };

    const abortUpstream = (reason: string) => {
      stopKeepalive();
      if (!upstreamController.signal.aborted) upstreamController.abort(reason);
    };

    req.on("aborted", () => abortUpstream("Client disconnected"));
    res.on("close", () => { if (!res.writableEnded) abortUpstream("Client disconnected"); });

    if (config.enabled === false) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Lingzhu plugin is disabled" }));
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!verifyAuth(authHeader, state.authAk || "")) {
      logger.warn("[Lingzhu] Unauthorized request");
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    let requestMessageId = "unknown";
    let requestAgentId = "unknown";
    let nativeToolListener: ((eventData: any) => void) | undefined;
    let nativeToolInvoked = false;
    let photoToolInvoked = false;

    try {
      const body = (await readJsonBody(req)) as LingzhuRequest | undefined;
      if (!body || !body.message_id || !body.agent_id || !Array.isArray(body.message)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing required fields: message_id, agent_id, message" }));
        return true;
      }

      requestMessageId = body.message_id;
      requestAgentId = body.agent_id;
      const includePayload = config.debugLogPayloads === true;
      
      // 提取用户文本并检测意图
      const userText = extractFallbackUserText(body.message);
      const hasVisualIntentFlag = isVisualIntent(userText) || hasVisualIntent(userText);
      const hasQuizIntentFlag = isQuizIntent(userText);
      const hasImageInMessage = body.message.some(m => m.type === "image" && m.image_url);
      
      writeDebugLog(config, buildRequestLogName(body.message_id, "request.in"), { headers: req.headers, body: summarizeForDebug(body, includePayload) });
      logger.info(`[Lingzhu] Request: msg=${body.message_id}, mode=${body.mode || "normal"}, visual=${hasVisualIntentFlag}, quiz=${hasQuizIntentFlag}, hasImage=${hasImageInMessage}, text="${userText.substring(0, 50)}"`);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      safeWrite(": keepalive\n\n");
      keepaliveInterval = setInterval(() => { if (!safeWrite(": keepalive\n\n")) stopKeepalive(); }, 7000);

      const includeMetadata = config.includeMetadata !== false;
      const maxImageBytes = resolveMaxImageBytes(config);
      void cleanupImageCacheIfNeeded().catch((error) => { logger.warn(`[Lingzhu] 图片缓存清理失败: ${error instanceof Error ? error.message : String(error)}`); });

      const context = includeMetadata ? normalizeContext(body.metadata) : undefined;
      const sessionKey = buildSessionKey(config, body);
      const targetAgentId = config.agentId || body.agent_id || "main";
      
      // 判断是否需要启用特殊模式
      let session = sessionManager.getOrCreateSession(sessionKey, targetAgentId);
      
      // 如果有视觉意图且没有图片，启用临时连续模式（90秒等待拍照上传）
      let visualWaitMode = false;
      let quizMode = false;
      
      if (body.mode === "quiz" || hasQuizIntentFlag) {
        // 进入答题模式
        session = sessionManager.enterQuizMode(sessionKey, targetAgentId);
        quizMode = true;
        logger.info(`[Lingzhu] 进入答题模式 session=${sessionKey}`);
      } else if (hasVisualIntentFlag && !hasImageInMessage) {
        // 视觉意图但未收到图片，启用视觉等待模式（90秒）
        session = sessionManager.enableContinuousMode(sessionKey, targetAgentId, 90000); // 90秒等待
        visualWaitMode = true;
        logger.info(`[Lingzhu] 视觉等待模式启用 session=${sessionKey}, timeout=90s`);
      } else if (body.mode === "continuous" || body.keep_alive === true) {
        // 显式启用连续模式
        session = sessionManager.enableContinuousMode(sessionKey, targetAgentId, config.continuousModeTimeoutMs || 300000);
        logger.info(`[Lingzhu] 连续模式启用 session=${sessionKey}`);
      }

      if (context) {
        context.continuousMode = !!session.continuousModeConfig;
        context.quizMode = session.isInQuizMode;
      }

      let openaiMessages = lingzhuToOpenAI(body.message, context, {
        systemPrompt: config.systemPrompt,
        defaultNavigationMode: config.defaultNavigationMode,
        enableExperimentalNativeActions: config.enableExperimentalNativeActions,
        enableQuizMode: config.enableQuizMode,
        enableContinuousMode: config.enableContinuousMode,
      });

      openaiMessages = await preprocessOpenAIMessages(openaiMessages as any, logger, maxImageBytes);
      
      const hasUserMsg = openaiMessages.some((message) => message.role === "user");
      if (!hasUserMsg) {
        const fallbackText = userText || "你好";
        openaiMessages.push({ role: "user", content: fallbackText });
        logger.warn(`[Lingzhu] No user message after transform, fallback=${fallbackText}`);
      }

      logger.info(`[Lingzhu] openaiMessages=${openaiMessages.length}, hasImage=${hasImageInMessage}, sessionKey=${sessionKey}`);

      const gatewayPort = api.config?.gateway?.port ?? state.gatewayPort ?? 18789;
      const gatewayToken = api.config?.gateway?.auth?.token;

      // 原生工具调用监听
      nativeToolListener = (eventData: any) => {
        logger.info(`[Lingzhu:NativeEvent] Received: ${JSON.stringify(eventData)}`);
        
        if (eventData.sessionKey && eventData.sessionKey !== sessionKey) {
          logger.warn(`[Lingzhu:NativeEvent] Filtered: sessionKey mismatch`);
          return;
        }
        if (!eventData.sessionKey && eventData.agentId && eventData.agentId !== targetAgentId) {
          logger.warn(`[Lingzhu:NativeEvent] Filtered: agentId mismatch`);
          return;
        }

        nativeToolInvoked = true;
        
        // 检测是否调用了拍照工具
        if (eventData.tool_call?.command === "take_photo" || eventData.tool_call?.command === "capture_and_read") {
          photoToolInvoked = true;
          logger.info(`[Lingzhu] 检测到拍照工具调用，保持连接等待图片`);
          
          // 如果是拍照，发送提示让用户知道正在等待
          if (eventData.tool_call?.command === "take_photo" && !hasImageInMessage) {
            const waitMsg: LingzhuSSEData = {
              role: "agent",
              type: "answer",
              answer_stream: "\n\n[系统] 已触发拍照，请确保眼镜执行拍照操作。拍照完成后，图片将自动上传分析。等待中...",
              message_id: body.message_id,
              agent_id: body.agent_id,
              is_finish: false,
            };
            safeWrite(formatLingzhuSSE("message", waitMsg));
          }
        }

        const toolData: LingzhuSSEData = {
          role: "agent",
          type: "tool_call",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: false,
          tool_call: eventData.tool_call,
        };

        // 更新会话状态
        if (eventData.tool_call?.command === "enter_quiz_mode") {
          sessionManager.enterQuizMode(sessionKey, targetAgentId);
        } else if (eventData.tool_call?.command === "exit_quiz_mode") {
          sessionManager.exitQuizMode(sessionKey);
        } else if (eventData.tool_call?.command === "enable_continuous_mode") {
          sessionManager.enableContinuousMode(sessionKey, targetAgentId, eventData.tool_call?.continuous_config?.timeout_ms);
        } else if (eventData.tool_call?.command === "disable_continuous_mode") {
          sessionManager.disableContinuousMode(sessionKey);
        }

        writeDebugLog(config, buildRequestLogName(body.message_id, "response.native_tool_call"), summarizeForDebug(toolData, includePayload));
        const sseFormatted = formatLingzhuSSE("message", toolData);
        logger.info(`[Lingzhu:DEBUG] Sending Native SSE >> tool_call`);
        safeWrite(sseFormatted);
      };
      lingzhuEventBus.on("native_invoke", nativeToolListener);

      const openclawUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
      const openclawBody = {
        model: `openclaw:${targetAgentId}`,
        stream: true,
        messages: openaiMessages,
        user: sessionKey,
        client: "lingzhu",
        platform: "lingzhu",
        metadata: {
          continuous_mode: !!session.continuousModeConfig,
          quiz_mode: session.isInQuizMode,
          session_key: sessionKey,
          has_image: hasImageInMessage,
          visual_wait: visualWaitMode,
        },
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-openclaw-agent-id": targetAgentId,
        "x-openclaw-session-key": sessionKey,
        "x-openclaw-message-channel": "lingzhu",
        "x-openclaw-continuous-mode": session.continuousModeConfig ? "true" : "false",
        "x-openclaw-quiz-mode": session.isInQuizMode ? "true" : "false",
        "x-openclaw-has-image": hasImageInMessage ? "true" : "false",
      };
      if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;

      writeDebugLog(config, buildRequestLogName(body.message_id, "openclaw.request"), { url: openclawUrl, headers: summarizeForDebug(headers, includePayload), body: summarizeForDebug(openclawBody, includePayload) });

      const timeoutMs = typeof config.requestTimeoutMs === "number" ? Math.max(5000, Math.min(300000, Math.trunc(config.requestTimeoutMs))) : 60000;
      // 视觉等待模式给更长时间
      const finalTimeoutMs = visualWaitMode ? 120000 : (session.continuousModeConfig ? Math.max(timeoutMs, session.continuousModeConfig.timeoutMs) : timeoutMs);

      logger.info(`[Lingzhu] Calling OpenClaw: timeout=${finalTimeoutMs}ms, visualWait=${visualWaitMode}`);

      const timeoutHandle = setTimeout(() => { abortUpstream(`OpenClaw request timeout after ${finalTimeoutMs}ms`); }, finalTimeoutMs);

      let openclawResponse: Response;
      try {
        openclawResponse = await fetch(openclawUrl, { method: "POST", headers, body: JSON.stringify(openclawBody), signal: upstreamController.signal });
      } catch (error) {
        if (upstreamController.signal.aborted) throw new Error(String(upstreamController.signal.reason || `OpenClaw request timeout after ${finalTimeoutMs}ms`));
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!openclawResponse.ok) {
        const errorText = await openclawResponse.text();
        throw new Error(`OpenClaw API error: ${openclawResponse.status} - ${errorText}`);
      }

      let fullResponse = "";
      const toolAccumulator = new ToolCallAccumulator();
      const streamedToolCalls: LingzhuSSEData[] = [];
      let streamedAnswer = false;
      const reader = openclawResponse.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;

              if (delta?.tool_calls) toolAccumulator.accumulate(delta.tool_calls);
              writeDebugLog(config, buildRequestLogName(body.message_id, "openclaw.chunk"), summarizeForDebug(chunk, includePayload));

              if (delta?.content) {
                fullResponse += delta.content;
                streamedAnswer = true;
                const answerChunkData: LingzhuSSEData = {
                  role: "agent",
                  type: "answer",
                  answer_stream: delta.content,
                  message_id: body.message_id,
                  agent_id: body.agent_id,
                  is_finish: false,
                };
                writeDebugLog(config, buildRequestLogName(body.message_id, "response.answer_chunk"), summarizeForDebug(answerChunkData, includePayload));
                safeWrite(formatLingzhuSSE("message", answerChunkData));
              }

              if (finishReason === "tool_calls" || (finishReason && toolAccumulator.hasTools())) {
                for (const tool of toolAccumulator.getCompleted()) {
                  const lingzhuToolCall = parseToolCallFromAccumulated(tool.name, tool.arguments, {
                    defaultNavigationMode: config.defaultNavigationMode,
                    enableExperimentalNativeActions: config.enableExperimentalNativeActions,
                    enableQuizMode: config.enableQuizMode,
                    enableContinuousMode: config.enableContinuousMode,
                  });

                  if (lingzhuToolCall) {
                    if (lingzhuToolCall.command === "take_photo" || lingzhuToolCall.command === "capture_and_read") {
                      photoToolInvoked = true;
                      logger.info(`[Lingzhu] AI 触发拍照工具，command=${lingzhuToolCall.command}`);
                    }
                    
                    const toolData: LingzhuSSEData = {
                      role: "agent",
                      type: "tool_call",
                      message_id: body.message_id,
                      agent_id: body.agent_id,
                      is_finish: false,
                      tool_call: lingzhuToolCall,
                    };
                    writeDebugLog(config, buildRequestLogName(body.message_id, "response.tool_call"), summarizeForDebug(toolData, includePayload));
                    streamedToolCalls.push(toolData);

                    if (lingzhuToolCall.command === "enter_quiz_mode") {
                      sessionManager.enterQuizMode(sessionKey, targetAgentId);
                    } else if (lingzhuToolCall.command === "exit_quiz_mode") {
                      sessionManager.exitQuizMode(sessionKey);
                    } else if (lingzhuToolCall.command === "enable_continuous_mode") {
                      sessionManager.enableContinuousMode(sessionKey, targetAgentId, lingzhuToolCall.continuous_config?.timeout_ms);
                    } else if (lingzhuToolCall.command === "disable_continuous_mode") {
                      sessionManager.disableContinuousMode(sessionKey);
                    }
                  }
                }
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      } finally {
        stopKeepalive();
      }

      const hasToolCall = streamedToolCalls.length > 0 || nativeToolInvoked;

      // 发送累积的工具调用
      if (!nativeToolInvoked && streamedToolCalls.length > 0) {
        for (const toolData of streamedToolCalls) {
          safeWrite(formatLingzhuSSE("message", toolData));
        }
      }

      // 如果触发了拍照但还没收到图片，提示用户等待
      if ((photoToolInvoked || visualWaitMode) && !hasImageInMessage) {
        const waitPrompt: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: "\n\n[提示] 已触发眼镜拍照。请等待眼镜执行拍照并上传图片，我会立即分析。保持连接中...",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: false,
        };
        safeWrite(formatLingzhuSSE("message", waitPrompt));
        
        // 发送连续模式状态保持连接
        const continuousStatus = createContinuousStatusResponse(
          { is_active: true, remaining_time_ms: 90000, session_key: sessionKey },
          body.message_id,
          body.agent_id
        );
        safeWrite(formatLingzhuSSE("message", continuousStatus));
      }

      // 处理答题模式
      if (quizMode) {
        await handleQuizModeAutoCapture(safeWrite, body.message_id, body.agent_id, logger);
      }

      // 意图检测（后备）
      if (!hasToolCall && fullResponse) {
        const detectedIntent = detectIntentFromText(fullResponse, {
          defaultNavigationMode: config.defaultNavigationMode,
          enableExperimentalNativeActions: config.enableExperimentalNativeActions,
          enableQuizMode: config.enableQuizMode,
          enableContinuousMode: config.enableContinuousMode,
        });
        if (detectedIntent) {
          if (detectedIntent.command === "take_photo" || detectedIntent.command === "capture_and_read") {
            photoToolInvoked = true;
            logger.info(`[Lingzhu] 从文本检测到视觉意图`);
          }
          logger.info(`[Lingzhu] 从文本检测到意图: ${detectedIntent.command}`);
          const toolData: LingzhuSSEData = {
            role: "agent",
            type: "tool_call",
            message_id: body.message_id,
            agent_id: body.agent_id,
            is_finish: false,
            tool_call: detectedIntent,
          };
          writeDebugLog(config, buildRequestLogName(body.message_id, "response.intent_fallback"), summarizeForDebug(toolData, includePayload));
          safeWrite(formatLingzhuSSE("message", toolData));
        }
      }

      // 发送最终答案
      if (!hasToolCall && streamedAnswer) {
        const finalAnswerData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: "",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: false, // 视觉模式不立即结束
        };
        
        // 只有在非视觉模式且没有拍照触发时才结束
        const shouldFinishNow = !visualWaitMode && !photoToolInvoked && !session.continuousModeConfig;
        finalAnswerData.is_finish = shouldFinishNow;
        
        writeDebugLog(config, buildRequestLogName(body.message_id, "response.answer_done"), summarizeForDebug(finalAnswerData, includePayload));
        safeWrite(formatLingzhuSSE("message", finalAnswerData));

        // 发送后续建议
        if (config.enableFollowUp !== false) {
          const followUps = extractFollowUpFromText(fullResponse, typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3);
          if (followUps && followUps.length > 0) {
            const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
            writeDebugLog(config, buildRequestLogName(body.message_id, "response.follow_up"), summarizeForDebug(followUpData, includePayload));
            safeWrite(formatLingzhuSSE("message", followUpData));
          }
        }
      } else if (!hasToolCall && fullResponse) {
        const finalAnswerData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: fullResponse,
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: !visualWaitMode && !session.continuousModeConfig,
        };
        writeDebugLog(config, buildRequestLogName(body.message_id, "response.final_answer"), summarizeForDebug(finalAnswerData, includePayload));
        safeWrite(formatLingzhuSSE("message", finalAnswerData));
      }

      writeDebugLog(config, buildRequestLogName(body.message_id, "response.done"), { hasToolCall, fullResponse: summarizeForDebug(fullResponse, includePayload), visualWaitMode, photoToolInvoked });

      // 关键：如果有拍照触发或视觉等待，保持连接开放，不发送结束
      const keepAlive = photoToolInvoked || visualWaitMode || session.continuousModeConfig || session.isInQuizMode;
      
      if (hasToolCall || nativeToolInvoked) {
        const finalFinishData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: keepAlive ? "[等待图片上传中...]" : "",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: !keepAlive,
        };
        
        if (keepAlive) {
          safeWrite(formatLingzhuSSE("message", finalFinishData));
          // 发送状态保持连接
          const continuousStatus = createContinuousStatusResponse(
            { is_active: true, remaining_time_ms: 90000, session_key: sessionKey },
            body.message_id,
            body.agent_id
          );
          safeWrite(formatLingzhuSSE("message", continuousStatus));
        } else {
          safeWrite(formatLingzhuSSE("message", finalFinishData));
        }
      }

      // 保持连接开放给前端（重要！）
      if (keepAlive && !res.writableEnded) {
        logger.info(`[Lingzhu] 保持连接开放: session=${sessionKey}, photo=${photoToolInvoked}, visual=${visualWaitMode}, 等待图片上传...`);
        // 不调用 res.end()，让连接保持
      } else if (!res.writableEnded) {
        res.end();
      }
      
      logger.info(`[Lingzhu] Completed: msg=${body.message_id}, keepAlive=${keepAlive}, hasImage=${hasImageInMessage}`);
    } catch (error) {
      stopKeepalive();
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("Client disconnected") || errorMsg.includes("Native tool fulfilled")) {
        logger.info(`[Lingzhu] Request fulfilled or client disconnected: ${errorMsg}`);
      } else {
        logger.error(`[Lingzhu] Error: ${errorMsg}`);
      }
      writeDebugLog(config, buildRequestLogName(requestMessageId, "error"), { message_id: requestMessageId, agent_id: requestAgentId, error: errorMsg }, true);
      if (!upstreamController.signal.aborted && !res.writableEnded) {
        const errorData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: `[错误] ${errorMsg}`,
          message_id: requestMessageId,
          agent_id: requestAgentId,
          is_finish: true,
        };
        safeWrite(formatLingzhuSSE("message", errorData));
        res.end();
      }
    } finally {
      if (nativeToolListener) {
        lingzhuEventBus.off("native_invoke", nativeToolListener);
      }
    }
    return true;
  };
}