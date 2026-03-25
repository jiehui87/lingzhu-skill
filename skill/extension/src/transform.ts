import type {
  LingzhuMessage,
  LingzhuContext,
  LingzhuSSEData,
  LingzhuToolCall,
} from "./types.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: string; image_url?: { url: string } }[];
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

interface LingzhuTransformOptions {
  systemPrompt?: string;
  defaultNavigationMode?: "0" | "1" | "2";
  enableExperimentalNativeActions?: boolean;
  enableQuizMode?: boolean;
  enableContinuousMode?: boolean;
}

const EXPERIMENTAL_COMMANDS = new Set([
  "send_notification",
  "send_toast",
  "speak_tts",
  "start_video_record",
  "stop_video_record",
  "open_custom_view",
  "enter_quiz_mode",
  "exit_quiz_mode",
  "capture_and_read",
  "enable_continuous_mode",
  "disable_continuous_mode",
]);

const ALLOWED_MARKER_COMMANDS = new Set([
  "take_photo",
  "take_navigation",
  "notify_agent_off",
  "control_calendar",
  "send_notification",
  "send_toast",
  "speak_tts",
  "start_video_record",
  "stop_video_record",
  "open_custom_view",
  "enter_quiz_mode",
  "exit_quiz_mode",
  "capture_and_read",
  "enable_continuous_mode",
  "disable_continuous_mode",
]);

function resolveNavigationMode(
  value: unknown,
  fallback: "0" | "1" | "2" = "0"
): "0" | "1" | "2" {
  return value === "1" || value === "2" ? value : fallback;
}

function createDefaultSystemPrompt(enableExperimentalNativeActions = false, enableQuizMode = false, enableContinuousMode = false): string {
  const lines = [
    "你是灵珠设备桥接助手，需要优先把用户意图转换成设备工具调用。",
    "当用户要求拍照、拍摄、照相或记录当前画面时，必须调用 take_photo。",
    "当用户问'这是什么'、'看一下这个'、'帮我看看'等询问眼前物品时，必须调用 take_photo 拍照并分析。",
    "当用户要求导航、带路、去某地时，必须调用 navigate，并尽量补充 destination。",
    "当用户要求添加日程、设置提醒、安排事项时，必须调用 calendar。",
    "当用户要求退出、结束当前智能体会话时，必须调用 exit_agent。",
    "【重要】用户询问'这是什么'时，立即调用 take_photo 拍照，不要只回复文字。",
    "【重要】调用 take_photo 后，系统会自动保持连接，等待图片上传后进行分析。",
    "不要把工具调用伪装成普通文本说明；能调用工具时优先调用工具。",
  ];

  if (enableExperimentalNativeActions) {
    lines.push("当用户要求发送眼镜通知时，调用 send_notification。");
    lines.push("当用户要求发送轻提示或 Toast 时，调用 send_toast。");
    lines.push("当用户要求眼镜直接播报文本时，调用 speak_tts。");
    lines.push("当用户要求开始录像时，调用 start_video_record；要求停止录像时，调用 stop_video_record。");
    lines.push("当用户要求打开自定义页面或实验界面时，调用 open_custom_view。");
  }

  if (enableQuizMode) {
    lines.push("当用户要求进入答题模式、开始答题、连续拍照答题时，调用 enter_quiz_mode。");
    lines.push("当用户要求退出答题模式、停止答题时，调用 exit_quiz_mode。");
    lines.push("当用户要求拍照并识别文字、识别题目时，调用 capture_and_read。");
    lines.push("答题模式下，会自动连续拍照识别，你只需回答识别到的问题内容。");
  }

  if (enableContinuousMode) {
    lines.push("当用户要求保持连接、不要退出、连续对话时，调用 enable_continuous_mode。");
    lines.push("当用户可以切换功能而不退出，比如从语音切换到拍照或录像，保持智能体连接。");
    lines.push("【重要】调用拍照（take_photo）后，系统会自动保持连接60秒，等待图片上传进行分析。");
    lines.push("【重要】不要连续调用两次 exit_agent，调用拍照后要保持活跃等待图片。");
  }

  return lines.join("\n");
}

const TOOL_COMMAND_MAP: Record<string, LingzhuToolCall["command"]> = {
  take_photo: "take_photo",
  camera: "take_photo",
  photo: "take_photo",
  takepicture: "take_photo",
  snapshot: "take_photo",

  navigate: "take_navigation",
  navigation: "take_navigation",
  take_navigation: "take_navigation",
  maps: "take_navigation",
  route: "take_navigation",
  directions: "take_navigation",

  calendar: "control_calendar",
  add_calendar: "control_calendar",
  control_calendar: "control_calendar",
  schedule: "control_calendar",
  reminder: "control_calendar",
  add_reminder: "control_calendar",
  create_event: "control_calendar",
  set_schedule: "control_calendar",

  exit_agent: "notify_agent_off",
  exit: "notify_agent_off",
  quit: "notify_agent_off",
  notify_agent_off: "notify_agent_off",
  close_agent: "notify_agent_off",
  leave_agent: "notify_agent_off",

  send_notification: "send_notification",
  notification: "send_notification",
  notify: "send_notification",
  send_toast: "send_toast",
  toast: "send_toast",
  speak_tts: "speak_tts",
  tts: "speak_tts",
  speak: "speak_tts",
  start_video_record: "start_video_record",
  start_recording: "start_video_record",
  record_video: "start_video_record",
  stop_video_record: "stop_video_record",
  stop_recording: "stop_video_record",
  open_custom_view: "open_custom_view",
  custom_view: "open_custom_view",
  show_view: "open_custom_view",
  
  enter_quiz_mode: "enter_quiz_mode",
  start_quiz: "enter_quiz_mode",
  quiz_mode: "enter_quiz_mode",
  exit_quiz_mode: "exit_quiz_mode",
  stop_quiz: "exit_quiz_mode",
  capture_and_read: "capture_and_read",
  photo_read: "capture_and_read",
  ocr_capture: "capture_and_read",
  enable_continuous_mode: "enable_continuous_mode",
  keep_alive: "enable_continuous_mode",
  continuous_mode: "enable_continuous_mode",
  disable_continuous_mode: "disable_continuous_mode",
  allow_exit: "disable_continuous_mode",
};

function resolveToolCommand(
  toolName: string,
  options: LingzhuTransformOptions = {}
): LingzhuToolCall["command"] | null {
  const command = TOOL_COMMAND_MAP[toolName.toLowerCase()] ?? null;
  if (!command) return null;
  if (EXPERIMENTAL_COMMANDS.has(command) && options.enableExperimentalNativeActions !== true) return null;
  return command;
}

export class ToolCallAccumulator {
  private tools: Map<number, { id: string; name: string; arguments: string }> = new Map();

  accumulate(toolCalls: OpenAIToolCall[]): void {
    for (const tc of toolCalls) {
      const index = tc.index ?? 0;
      if (!this.tools.has(index)) {
        this.tools.set(index, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
      }
      const existing = this.tools.get(index)!;
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    }
  }

  getCompleted(): Array<{ id: string; name: string; arguments: string }> {
    return Array.from(this.tools.values()).filter((tool) => tool.name);
  }

  hasTools(): boolean {
    return this.tools.size > 0;
  }

  clear(): void {
    this.tools.clear();
  }
}

function decodeMarkerParams(rawValue: string): Record<string, unknown> {
  const value = rawValue.trim();
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function extractLingzhuToolMarker(
  text: string
): { command: LingzhuToolCall["command"]; params: Record<string, unknown> } | null {
  const markerPrefix = "@@@LINGZHU_TOOL:";
  const markerStart = text.indexOf(markerPrefix);
  if (markerStart < 0) return null;
  const commandSeparator = text.indexOf(":", markerStart + markerPrefix.length);
  const markerEnd = text.indexOf("@@@", commandSeparator + 1);
  if (commandSeparator < 0 || markerEnd < 0) return null;
  const command = text.slice(markerStart + markerPrefix.length, commandSeparator).trim();
  if (!ALLOWED_MARKER_COMMANDS.has(command as LingzhuToolCall["command"])) return null;
  return {
    command: command as LingzhuToolCall["command"],
    params: decodeMarkerParams(text.slice(commandSeparator + 1, markerEnd)),
  };
}

export function detectIntentFromText(
  text: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const experimentalEnabled = options.enableExperimentalNativeActions === true;
  const quizModeEnabled = options.enableQuizMode === true;
  const continuousModeEnabled = options.enableContinuousMode === true;

  const markerMatch = extractLingzhuToolMarker(text);
  if (markerMatch) {
    const command = markerMatch.command;
    if (EXPERIMENTAL_COMMANDS.has(command) && !experimentalEnabled) return null;
    const rawParams = markerMatch.params;
    const toolCall: LingzhuToolCall = {
      handling_required: true,
      command,
      is_recall: true,
    };

    if (command === "take_navigation") {
      toolCall.action = "open";
      if (rawParams.destination) toolCall.poi_name = String(rawParams.destination);
      toolCall.navi_type = resolveNavigationMode(rawParams.navi_type, defaultNavigationMode);
    } else if (command === "control_calendar") {
      toolCall.action = "create";
      if (rawParams.title) toolCall.title = String(rawParams.title);
      if (rawParams.start_time) toolCall.start_time = String(rawParams.start_time);
      if (rawParams.end_time) toolCall.end_time = String(rawParams.end_time);
    } else if (command === "send_notification" || command === "send_toast" || command === "speak_tts") {
      if (rawParams.content) toolCall.content = String(rawParams.content);
      if (typeof rawParams.play_tts === "boolean") toolCall.play_tts = rawParams.play_tts;
      if (rawParams.icon_type) toolCall.icon_type = String(rawParams.icon_type);
    } else if (command === "start_video_record") {
      if (typeof rawParams.duration_sec === "number") toolCall.duration_sec = rawParams.duration_sec;
      if (typeof rawParams.width === "number") toolCall.width = rawParams.width;
      if (typeof rawParams.height === "number") toolCall.height = rawParams.height;
      if (typeof rawParams.quality === "number") toolCall.quality = rawParams.quality;
    } else if (command === "open_custom_view") {
      if (rawParams.view_name) toolCall.view_name = String(rawParams.view_name);
      if (rawParams.view_payload) {
        toolCall.view_payload = typeof rawParams.view_payload === "string" ? rawParams.view_payload : JSON.stringify(rawParams.view_payload);
      }
    } else if (command === "enter_quiz_mode") {
      toolCall.quiz_config = {
        auto_capture: rawParams.auto_capture !== false,
        capture_interval_ms: typeof rawParams.capture_interval_ms === "number" ? rawParams.capture_interval_ms : 5000,
        max_captures: typeof rawParams.max_captures === "number" ? rawParams.max_captures : 10,
      };
    } else if (command === "capture_and_read") {
      toolCall.capture_config = {
        ocr_enabled: rawParams.ocr_enabled !== false,
        question_text: rawParams.question_text ? String(rawParams.question_text) : undefined,
      };
    } else if (command === "enable_continuous_mode") {
      toolCall.continuous_config = {
        timeout_ms: typeof rawParams.timeout_ms === "number" ? rawParams.timeout_ms : 300000,
        keep_tools_active: rawParams.keep_tools_active !== false,
      };
    }
    return toolCall;
  }

  const patterns: Array<{ regex: RegExp; command: LingzhuToolCall["command"]; quiz?: boolean; continuous?: boolean; visual?: boolean }> = [
    { regex: /拍照|拍张照|照相|拍一张|帮我拍/, command: "take_photo" },
    { regex: /退出智能体|退出当前会话|结束对话|关闭智能体/, command: "notify_agent_off" },
  ];

  if (experimentalEnabled) {
    patterns.push({ regex: /发(一条|个)?通知|发送通知/, command: "send_notification" });
    patterns.push({ regex: /toast|轻提示|弹出提示/i, command: "send_toast" });
    patterns.push({ regex: /播报|朗读|语音提示|念一段/, command: "speak_tts" });
    patterns.push({ regex: /开始录像|录一段视频|开始录制/, command: "start_video_record" });
    patterns.push({ regex: /停止录像|结束录像|停止录制/, command: "stop_video_record" });
    patterns.push({ regex: /打开.*页面|显示.*页面|展示.*页面/, command: "open_custom_view" });
  }

  if (quizModeEnabled) {
    patterns.push({ regex: /进入答题模式|开始答题|连续拍照答题|答题助手/, command: "enter_quiz_mode", quiz: true });
    patterns.push({ regex: /退出答题模式|停止答题|结束答题/, command: "exit_quiz_mode", quiz: true });
    patterns.push({ regex: /拍照识别|识别题目|读取图片|OCR识别|拍照读取/, command: "capture_and_read", quiz: true });
  }

  if (continuousModeEnabled) {
    patterns.push({ regex: /保持连接|不要退出|连续对话|持续模式|保持在线/, command: "enable_continuous_mode", continuous: true });
    patterns.push({ regex: /允许退出|结束连续|关闭持续模式/, command: "disable_continuous_mode", continuous: true });
  }

  // 视觉意图检测 - 这些会触发拍照并保持连接
  const visualPatterns = [
    { regex: /这是什么|这是啥|看下这个|看看这个|帮我看下|看一下|这是什么东西|识别一下/i, command: "take_photo" as const, visual: true },
    { regex: /前面有什么|周围有什么|看看前面|看一下周围/i, command: "take_photo" as const, visual: true },
    { regex: /拍一下|照一下|拍张照片/i, command: "take_photo" as const, visual: true },
  ];
  
  for (const pattern of visualPatterns) {
    if (pattern.regex.test(text)) {
      return {
        handling_required: true,
        command: pattern.command,
        is_recall: true,
      };
    }
  }

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      const result: LingzhuToolCall = {
        handling_required: true,
        command: pattern.command,
        is_recall: true,
      };
      if (pattern.quiz && pattern.command === "enter_quiz_mode") {
        result.quiz_config = { auto_capture: true, capture_interval_ms: 5000, max_captures: 10 };
      }
      if (pattern.continuous && pattern.command === "enable_continuous_mode") {
        result.continuous_config = { timeout_ms: 300000, keep_tools_active: true };
      }
      return result;
    }
  }

  const navigationMatch = text.match(/(?:导航(?:到|去)?|前往|带我去|带路去)\s*[:：]?\s*([^\n，。！？]+)/);
  if (navigationMatch?.[1]) {
    return {
      handling_required: true,
      command: "take_navigation",
      is_recall: true,
      action: "open",
      poi_name: navigationMatch[1].trim(),
      navi_type: defaultNavigationMode,
    };
  }

  return null;
}

export function lingzhuToOpenAI(
  messages: LingzhuMessage[],
  context?: LingzhuContext,
  options: LingzhuTransformOptions = {}
): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = [];
  const systemParts: string[] = [
    createDefaultSystemPrompt(
      options.enableExperimentalNativeActions === true,
      options.enableQuizMode === true,
      options.enableContinuousMode === true
    )
  ];

  if (options.systemPrompt) systemParts.push(options.systemPrompt);

  if (context?.continuousMode) {
    systemParts.push("【当前处于连续对话模式】智能体不会自动退出，可以持续交互。切换功能（如拍照、录像）后仍保持连接。");
  }
  if (context?.quizMode) {
    systemParts.push("【当前处于答题模式】系统会自动拍照识别题目，请根据识别到的内容作答。");
  }

  if (systemParts.length > 0) {
    openaiMessages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  if (context) {
    const parts: string[] = [];
    if (context.currentTime) parts.push(`当前时间: ${context.currentTime}`);
    if (context.location) parts.push(`位置: ${context.location}`);
    if (context.weather) parts.push(`天气: ${context.weather}`);
    if (context.battery) parts.push(`电量: ${context.battery}%`);
    if (context.latitude && context.longitude) parts.push(`坐标: ${context.latitude}, ${context.longitude}`);
    if (context.lang) parts.push(`语言: ${context.lang}`);
    if (context.runningApp) parts.push(`当前运行应用: ${context.runningApp}`);
    if (parts.length > 0) {
      openaiMessages.push({ role: "system", content: `[rokid glasses 信息]\n${parts.join("\n")}` });
    }
  }

  for (const msg of messages) {
    const role = msg.role === "agent" ? "assistant" : "user";
    if (msg.type === "text" && msg.text) {
      openaiMessages.push({ role, content: msg.text });
    } else if (msg.type === "text" && msg.content) {
      openaiMessages.push({ role, content: msg.content });
    } else if (msg.type === "image" && msg.image_url) {
      openaiMessages.push({
        role,
        content: [{ type: "image_url", image_url: { url: msg.image_url } }],
      });
    }
  }

  return openaiMessages;
}

export function parseToolCallFromAccumulated(
  toolName: string,
  argsStr: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const command = resolveToolCommand(toolName, options);
  if (!command) return null;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr || "{}");
  } catch {
    args = {};
  }

  const toolCall: LingzhuToolCall = {
    handling_required: true,
    command,
    is_recall: true,
  };

  switch (command) {
    case "take_navigation":
      toolCall.action = (args.action as string) || "open";
      if (args.destination || args.poi_name || args.address) {
        toolCall.poi_name = String(args.destination || args.poi_name || args.address);
      }
      toolCall.navi_type = resolveNavigationMode(args.navi_type ?? args.type, defaultNavigationMode);
      break;

    case "control_calendar":
      toolCall.action = (args.action as string) || "create";
      if (args.title) toolCall.title = String(args.title);
      if (args.start_time || args.startTime) toolCall.start_time = String(args.start_time || args.startTime);
      if (args.end_time || args.endTime) toolCall.end_time = String(args.end_time || args.endTime);
      break;

    case "send_notification":
    case "send_toast":
    case "speak_tts":
      if (args.content) toolCall.content = String(args.content);
      if (typeof args.play_tts === "boolean") toolCall.play_tts = args.play_tts;
      if (args.icon_type) toolCall.icon_type = String(args.icon_type);
      break;

    case "start_video_record":
      if (typeof args.duration_sec === "number") toolCall.duration_sec = args.duration_sec;
      if (typeof args.width === "number") toolCall.width = args.width;
      if (typeof args.height === "number") toolCall.height = args.height;
      if (typeof args.quality === "number") toolCall.quality = args.quality;
      break;

    case "open_custom_view":
      if (args.view_name) toolCall.view_name = String(args.view_name);
      if (args.view_payload) {
        toolCall.view_payload = typeof args.view_payload === "string" ? args.view_payload : JSON.stringify(args.view_payload);
      }
      break;
      
    case "enter_quiz_mode":
      toolCall.quiz_config = {
        auto_capture: args.auto_capture !== false,
        capture_interval_ms: typeof args.capture_interval_ms === "number" ? args.capture_interval_ms : 5000,
        max_captures: typeof args.max_captures === "number" ? args.max_captures : 10,
      };
      break;
      
    case "capture_and_read":
      toolCall.capture_config = {
        ocr_enabled: args.ocr_enabled !== false,
        question_text: args.question_text ? String(args.question_text) : undefined,
      };
      break;
      
    case "enable_continuous_mode":
      toolCall.continuous_config = {
        timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : 300000,
        keep_tools_active: args.keep_tools_active !== false,
      };
      break;
      
    case "exit_quiz_mode":
    case "disable_continuous_mode":
      break;
  }

  return toolCall;
}

export function openaiChunkToLingzhu(
  chunk: OpenAIChunk,
  messageId: string,
  agentId: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const content = delta?.content || "";
  const isFinish = choice?.finish_reason != null;
  const toolCalls = delta?.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    const tc = toolCalls[0];
    if (tc.function?.name) {
      const parsedToolCall = parseToolCallFromAccumulated(tc.function.name, tc.function.arguments || "{}", options);
      if (parsedToolCall) {
        return {
          role: "agent",
          type: "tool_call",
          message_id: messageId,
          agent_id: agentId,
          is_finish: isFinish,
          tool_call: parsedToolCall,
        };
      }
    }
  }

  return {
    role: "agent",
    type: "answer",
    answer_stream: content,
    message_id: messageId,
    agent_id: agentId,
    is_finish: isFinish,
  };
}

export function createFollowUpResponse(
  suggestions: string[],
  messageId: string,
  agentId: string
): LingzhuSSEData {
  return {
    role: "agent",
    type: "follow_up",
    message_id: messageId,
    agent_id: agentId,
    is_finish: true,
    follow_up: suggestions,
  };
}

export function extractFollowUpFromText(text: string, limit = 3): string[] | null {
  const patterns = [
    /你还可以(?:问我|继续问|试试)[:：\s]*(.+)/,
    /(?:推荐|建议)(?:问题|提问)?[:：\s]*(.+)/,
    /(?:相关|更多)问题[:：\s]*(.+)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const suggestions = match[1]
      .split(/[,，;\n]/)
      .map((item) => item.replace(/^\d+[.、\s]*/, "").trim())
      .filter((item) => item.length > 0 && item.length < 100);
    if (suggestions.length > 0) return suggestions.slice(0, Math.max(0, limit));
  }
  return null;
}

export function formatLingzhuSSE(
  event: "message" | "done",
  data: LingzhuSSEData | string
): string {
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  return `event:${event}\ndata:${dataStr}\n\n`;
}

export function createQuizStatusResponse(
  status: {
    is_active: boolean;
    capture_count: number;
    max_captures: number;
    recognized_text?: string;
    answer?: string;
  },
  messageId: string,
  agentId: string
): LingzhuSSEData {
  return {
    role: "agent",
    type: "quiz_status",
    message_id: messageId,
    agent_id: agentId,
    is_finish: false,
    quiz_status: status,
  };
}

export function createContinuousStatusResponse(
  status: {
    is_active: boolean;
    remaining_time_ms: number;
    session_key: string;
  },
  messageId: string,
  agentId: string
): LingzhuSSEData {
  return {
    role: "agent",
    type: "continuous_status",
    message_id: messageId,
    agent_id: agentId,
    is_finish: false,
    continuous_status: status,
  };
}