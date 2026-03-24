import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingzhuConfig, LingzhuRequest, LingzhuSSEData, SessionState } from "./types.js";
import {
  formatLingzhuSSE,
  lingzhuToOpenAI,
  detectVisualIntent,
} from "./transform.js";

// 全局请求管理 - 用于打断所有交互
const activeControllers = new Map<string, { 
  controller: AbortController; 
  res: ServerResponse;
  startTime: number;
  requestType: string;  // 记录请求类型：chat, photo, navigation, answer 等
}>();

// 强制中断指定 agent 的所有活跃请求
function abortExisting(agentId: string, reason: string = "new_request"): boolean {
  const existing = activeControllers.get(agentId);
  if (existing) {
    const duration = Date.now() - existing.startTime;
    console.log(`[打断] agentId=${agentId}, 原因=${reason}, 已运行=${duration}ms, 类型=${existing.requestType}`);
    
    try {
      existing.controller.abort();
      if (!existing.res.writableEnded) {
        try {
          // 发送打断标记并立即结束
          existing.res.write(formatLingzhuSSE("message", {
            role: "agent", 
            type: "answer", 
            answer_stream: "（已打断）",
            message_id: "interrupt", 
            agent_id: agentId, 
            is_finish: true,
          }));
          existing.res.end();
        } catch (e) {
          console.log(`[打断] 结束旧响应失败: ${e}`);
        }
      }
    } catch (e) {
      console.log(`[打断] abort 失败: ${e}`);
    }
    activeControllers.delete(agentId);
    return true;
  }
  return false;
}

function registerController(agentId: string, controller: AbortController, res: ServerResponse, requestType: string): void {
  // 关键：任何新请求都强制中断旧请求
  abortExisting(agentId, requestType);
  activeControllers.set(agentId, { 
    controller, 
    res, 
    startTime: Date.now(),
    requestType 
  });
}

function unregisterController(agentId: string): void {
  activeControllers.delete(agentId);
}

// 会话管理
const sessionStore = new Map<string, {
  lastActivity: number;
  continuousMode: boolean;
  lastPhotoTime: number;
}>();

function getSession(agentId: string) {
  const existing = sessionStore.get(agentId);
  const now = Date.now();
  
  if (existing) {
    if (now - existing.lastActivity > 600000) {  // 10分钟超时
      existing.continuousMode = false;
    }
    existing.lastActivity = now;
    return existing;
  }
  
  const newSession = {
    lastActivity: now,
    continuousMode: false,
    lastPhotoTime: 0,
  };
  sessionStore.set(agentId, newSession);
  return newSession;
}

// 检测打断指令（任何唤醒词或停止词都触发打断）
function isInterruptCommand(text: string): boolean {
  if (!text) return false;
  
  const stopWords = ["停止", "打断", "够了", "停", "别说了", "安静", "结束", "闭嘴", "别讲"];
  const wakeWords = ["灵珠", "林州", "林珠", "凌珠", "玲珠", "灵朱", "铃铛"];
  
  const hasStop = stopWords.some(w => text.includes(w));
  const hasWake = wakeWords.some(w => text.toLowerCase().includes(w.toLowerCase()));
  
  return hasStop || hasWake;
}

// 检测是否只是唤醒（不含其他内容）
function isWakeOnly(text: string): boolean {
  const wakeWords = ["灵珠", "林州", "林珠", "凌珠", "玲珠", "灵朱", "铃铛"];
  const cleanText = text.toLowerCase().trim();
  
  // 如果只包含唤醒词，没有其他内容
  return wakeWords.some(w => cleanText === w.toLowerCase()) || 
         wakeWords.some(w => cleanText === `小${w.toLowerCase()}`) ||
         cleanText.length <= 4;  // 很短的内容视为唤醒
}

// 检测开始连续模式
function isStartContinuousCommand(text: string): boolean {
  return ["开始答题", "开始做题", "连续答题", "开始看题", "看题", "答题", "做题"].some(t => text.includes(t));
}

// 检测停止连续模式
function isStopContinuousCommand(text: string): boolean {
  return ["停止答题", "结束答题", "退出", "不答了"].some(w => text.includes(w));
}

// URL转Base64
async function urlToBase64(imageUrl: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(imageUrl, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function writeSSE(res: ServerResponse, data: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try { return res.write(data); } catch { return false; }
}

export function createHttpHandler(api: any, getRuntimeState: () => any) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/metis/agent/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (url.pathname !== "/metis/agent/api/sse" || req.method !== "POST") return false;

    const logger = api.logger;
    const state = getRuntimeState();
    const config = state.config || {};

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    writeSSE(res, ":ok\n\n");

    // 读取请求体
    let body: LingzhuRequest;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (err) {
      logger.error(`[Lingzhu] 解析请求失败: ${err}`);
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", type: "answer", answer_stream: "格式错误",
        message_id: "unknown", agent_id: "unknown", is_finish: true,
      }));
      res.end();
      return true;
    }

    const agentId = body.agent_id || "unknown";
    const messageId = body.message_id || "unknown";
    const userText = body.message?.[body.message.length - 1]?.text || "";
    
    // 检测是否有图片
    const hasImageInMessage = body.message?.some(m => 
      m.type === "image" && (m.image_url || m.image)
    ) || false;
    const hasFirstRoundImage = !!body.first_round_image && body.first_round_image.length > 10;
    const hasImage = hasImageInMessage || hasFirstRoundImage;

    // 获取会话
    const session = getSession(agentId);
    
    // 判断请求类型
    let requestType = "chat";
    if (isStartContinuousCommand(userText)) requestType = "start_quiz";
    else if (hasImage) requestType = "recognize";
    else if (detectVisualIntent(userText)) requestType = "photo";
    
    console.log(`[Lingzhu] 新请求: "${userText.substring(0, 30)}" | 类型: ${requestType} | 连续: ${session.continuousMode} | 有图: ${hasImage}`);

    // ========== 关键：任何新请求都强制中断旧请求 ==========
    const wasInterrupted = abortExisting(agentId, requestType);
    
    // 创建新控制器
    const controller = new AbortController();
    registerController(agentId, controller, res, requestType);
    const signal = controller.signal;

    // ========== 处理打断后的响应 ==========
    if (wasInterrupted) {
      // 如果新请求只是唤醒词（如只说"灵珠"），响应"我在"
      if (isWakeOnly(userText)) {
        console.log(`[打断] 纯唤醒词，响应"我在"`);
        writeSSE(res, formatLingzhuSSE("message", {
          role: "agent", 
          type: "answer", 
          answer_stream: "我在，请说。",
          message_id, 
          agent_id, 
          is_finish: true,
        }));
        res.end();
        unregisterController(agentId);
        return true;
      }
      
      // 如果是停止指令
      if (isStopContinuousCommand(userText)) {
        session.continuousMode = false;
        writeSSE(res, formatLingzhuSSE("message", {
          role: "agent", 
          type: "answer", 
          answer_stream: "已停止。",
          message_id, 
          agent_id, 
          is_finish: true,
        }));
        res.end();
        unregisterController(agentId);
        return true;
      }
      
      // 其他情况（新指令打断旧回复），继续执行新指令...
      console.log(`[打断] 执行新指令: ${userText.substring(0, 20)}`);
    }

    // ========== 处理停止连续模式 ==========
    if (isStopContinuousCommand(userText)) {
      session.continuousMode = false;
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", type: "answer", answer_stream: "已退出答题模式。",
        message_id, agent_id, is_finish: true,
      }));
      res.end();
      unregisterController(agentId);
      return true;
    }

    // ========== 启动连续模式（开始答题）==========
    const isStartCmd = isStartContinuousCommand(userText);
    
    if (isStartCmd && !hasImage) {
      session.continuousMode = true;
      session.lastPhotoTime = 0;
      
      console.log(`[${agentId}] 启动连续答题模式，请求首次拍照`);
      
      // 发送拍照指令，保持连接等待平台执行
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", 
        type: "tool_call",
        message_id, 
        agent_id, 
        is_finish: false,
        tool_call: { 
          handling_required: true, 
          command: "take_photo", 
          is_recall: false
        }
      }));
      
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", 
        type: "answer",
        answer_stream: "请对准第一题拍照",
        message_id, 
        agent_id, 
        is_finish: false,
      }));
      
      // 保持连接30秒
      const timeout = setTimeout(() => {
        if (!res.writableEnded) {
          writeSSE(res, formatLingzhuSSE("message", {
            role: "agent", 
            type: "answer",
            answer_stream: "拍照超时",
            message_id, 
            agent_id, 
            is_finish: true,
          }));
          res.end();
          unregisterController(agentId);
        }
      }, 30000);
      
      req.on("close", () => {
        clearTimeout(timeout);
        unregisterController(agentId);
      });
      
      return true;
    }

    // ========== 收到图片，进行识别 ==========
    if (hasImage) {
      console.log(`[${agentId}] 收到图片，开始AI识别`);
      
      if (session.continuousMode) {
        session.lastPhotoTime = Date.now();
      }
    }

    // ========== 需要拍照（视觉意图或连续模式无图）==========
    const hasVisual = detectVisualIntent(userText);
    const needPhoto = (hasVisual || session.continuousMode) && !hasImage && !isStartCmd;
    
    if (needPhoto) {
      const isRecall = session.continuousMode && session.lastPhotoTime > 0;
      
      console.log(`[${agentId}] 请求拍照，is_recall: ${isRecall}`);
      
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", 
        type: "tool_call",
        message_id, 
        agent_id, 
        is_finish: false,
        tool_call: { 
          handling_required: true, 
          command: "take_photo", 
          is_recall: isRecall
        }
      }));
      
      const hint = isRecall ? "请拍下一题" : "请对准题目拍照";
      writeSSE(res, formatLingzhuSSE("message", {
        role: "agent", 
        type: "answer",
        answer_stream: hint,
        message_id, 
        agent_id, 
        is_finish: false,
      }));
      
      const timeout = setTimeout(() => {
        if (!res.writableEnded) {
          writeSSE(res, formatLingzhuSSE("message", {
            role: "agent", 
            type: "answer",
            answer_stream: "拍照超时",
            message_id, 
            agent_id, 
            is_finish: true,
          }));
          res.end();
          unregisterController(agentId);
        }
      }, 30000);
      
      req.on("close", () => {
        clearTimeout(timeout);
        unregisterController(agentId);
      });
      
      return true;
    }

    // ========== 普通AI对话（可中断）==========
    console.log(`[${agentId}] 进入AI对话流程`);
    
    // 启动心跳
    let heartbeatActive = true;
    const heartbeat = setInterval(() => {
      if (!heartbeatActive || res.writableEnded || signal.aborted) {
        clearInterval(heartbeat);
        return;
      }
      writeSSE(res, ":ping\n\n");
    }, 300);

    const cleanup = () => {
      heartbeatActive = false;
      clearInterval(heartbeat);
      unregisterController(agentId);
    };

    req.on("close", cleanup);
    signal.addEventListener('abort', () => {
      console.log(`[${agentId}] 收到abort信号，清理资源`);
      cleanup();
    });

    try {
      // 处理首轮图片
      if (hasFirstRoundImage && body.first_round_image) {
        console.log(`[${agentId}] 处理首轮图片，长度: ${body.first_round_image.length}`);
        body.message.push({ 
          role: "user", 
          type: "image", 
          image_url: `data:image/jpeg;base64,${body.first_round_image}` 
        } as any);
      }

      // 转换消息
      const openaiMessages = lingzhuToOpenAI(body.message, undefined, {
        systemPrompt: "你是学习助手。回答必须极其简洁，严格控制在15字以内，只给答案选项，禁止解释。",
        enableExperimentalNativeActions: true,
      });

      // 转换图片 URL
      for (const msg of openaiMessages) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "image_url" && part.image_url?.url?.startsWith('http')) {
              const b64 = await urlToBase64(part.image_url.url);
              if (b64) part.image_url.url = b64;
            }
          }
        }
      }

      // 检查是否已打断
      if (signal.aborted) {
        console.log(`[${agentId}] 请求开始前已被打断`);
        throw new Error("Interrupted");
      }

      const gatewayPort = api.config?.gateway?.port ?? 19137;
      const token = api.config?.gateway?.auth?.token;

      console.log(`[${agentId}] 请求AI...`);

      const fetchCtrl = new AbortController();
      const fetchTimer = setTimeout(() => fetchCtrl.abort(), 25000);
      
      // 关键：将外部中断信号转发到fetch
      const abortHandler = () => {
        console.log(`[${agentId}] 转发abort信号到fetch`);
        fetchCtrl.abort();
      };
      signal.addEventListener('abort', abortHandler);

      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          model: `openclaw:${config.agentId || "main"}`,
          messages: openaiMessages,
          stream: true,
          max_tokens: 30,
          temperature: 0.1,
        }),
        signal: fetchCtrl.signal,
      });

      clearTimeout(fetchTimer);
      signal.removeEventListener('abort', abortHandler);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No body");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullResponse = "";
      let lastSent = 0;
      let chunkCount = 0;

      console.log(`[${agentId}] 开始读取AI流...`);

      while (true) {
        // 检查是否被中断（每个循环都检查）
        if (signal.aborted) {
          console.log(`[${agentId}] AI流被中断，停止读取`);
          break;
        }

        const { done, value } = await reader.read();
        if (done) {
          console.log(`[${agentId}] AI流读取完成`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          // 检查是否被中断
          if (signal.aborted) {
            console.log(`[${agentId}] 处理行时被中断`);
            break;
          }
          
          if (!line.trim().startsWith("data: ")) continue;
          
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const content = chunk.choices?.[0]?.delta?.content;
            
            if (content) {
              fullResponse += content;
              chunkCount++;
              
              // 检查是否被中断
              if (signal.aborted) {
                console.log(`[${agentId}] 发送前被中断`);
                break;
              }
              
              // 每15字符或标点发送
              if (fullResponse.length - lastSent > 15 || /[。！？\n,，;；]/.test(content)) {
                const success = writeSSE(res, formatLingzhuSSE("message", {
                  role: "agent", 
                  type: "answer", 
                  answer_stream: fullResponse.slice(lastSent),
                  message_id, 
                  agent_id, 
                  is_finish: false,
                }));
                
                if (!success) {
                  console.log(`[${agentId}] SSE写入失败，可能连接已关闭`);
                  break;
                }
                
                lastSent = fullResponse.length;
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
        
        // 如果被中断，跳出外层循环
        if (signal.aborted) break;
      }

      console.log(`[${agentId}] AI流处理结束，总字符: ${fullResponse.length}, 中断状态: ${signal.aborted}`);

      // 发送剩余内容（如果未被中断）
      if (!signal.aborted && fullResponse.length > lastSent) {
        writeSSE(res, formatLingzhuSSE("message", {
          role: "agent", 
          type: "answer", 
          answer_stream: fullResponse.slice(lastSent),
          message_id, 
          agent_id, 
          is_finish: false,
        }));
      }

      // ========== 连续模式自动续拍 ==========
      if (session.continuousMode && hasImage && !signal.aborted) {
        const now = Date.now();
        if (now - session.lastPhotoTime > 500) {
          session.lastPhotoTime = now;
          
          console.log(`[${agentId}] 连续模式：请求下一题`);
          
          // 结束当前回答
          writeSSE(res, formatLingzhuSSE("message", {
            role: "agent", 
            type: "answer", 
            answer_stream: "",
            message_id, 
            agent_id, 
            is_finish: true,
          }));
          
          // 发送下一张拍照指令
          writeSSE(res, formatLingzhuSSE("message", {
            role: "agent", 
            type: "tool_call",
            message_id: `${messageId}_next`, 
            agent_id, 
            is_finish: false,
            tool_call: { 
              handling_required: true, 
              command: "take_photo", 
              is_recall: true
            }
          }));
          
          const timeout = setTimeout(() => {
            if (!res.writableEnded) {
              writeSSE(res, formatLingzhuSSE("message", {
                role: "agent", 
                type: "answer",
                answer_stream: "等待超时",
                message_id: `${messageId}_next`, 
                agent_id, 
                is_finish: true,
              }));
              res.end();
              unregisterController(agentId);
            }
          }, 30000);
          
          req.on("close", () => clearTimeout(timeout));
          return true;
        }
      }

      // 正常结束
      if (!res.writableEnded) {
        writeSSE(res, formatLingzhuSSE("message", {
          role: "agent", 
          type: "answer", 
          answer_stream: signal.aborted ? "（已打断）" : "",
          message_id, 
          agent_id, 
          is_finish: true,
        }));
      }

    } catch (err: any) {
      console.error(`[Lingzhu] 错误: ${err.message}`);
      
      if (!res.writableEnded) {
        const isAborted = signal.aborted || err.message === "Interrupted";
        writeSSE(res, formatLingzhuSSE("message", {
          role: "agent", 
          type: "answer", 
          answer_stream: isAborted ? "（已打断）" : "处理失败",
          message_id, 
          agent_id, 
          is_finish: true,
        }));
      }
    } finally {
      cleanup();
      if (!res.writableEnded) {
        try { res.end(); } catch {}
      }
    }

    return true;
  };
}