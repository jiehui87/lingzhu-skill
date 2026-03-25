import type { LingzhuToolCall } from "./types.js";
import { lingzhuEventBus } from "./events.js";
import { parseToolCallFromAccumulated } from "./transform.js";

type ToolParameters = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
};

type ToolExecuteResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type LingzhuToolDefinition = {
  name: string;
  command: LingzhuToolCall["command"];
  description: string;
  parameters: ToolParameters;
  experimental?: boolean;
  statusText?: (params: Record<string, any>) => string;
};

const EMPTY_PARAMS: ToolParameters = {
  type: "object",
  properties: {},
  required: [],
};

const TOOL_DEFINITIONS: LingzhuToolDefinition[] = [
  {
    name: "take_photo",
    command: "take_photo",
    description: "使用灵珠设备的摄像头拍照。当用户要求拍照、拍摄、照相时，必须调用此工具，或者有使用关于视觉能力(看一下这个东西，看一下我前面有什么)。在连续模式下，拍照后智能体不会退出。",
    parameters: EMPTY_PARAMS,
    statusText: () => "正在通过灵珠设备拍照...",
  },
  {
    name: "navigate",
    command: "take_navigation",
    description: "使用灵珠设备的导航功能，导航到指定地址或 POI。当用户要求导航、带路、去某地时，必须调用此工具。(注意不要回复，直接调用工具)。在连续模式下，导航后智能体不会退出。",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "目标地址或 POI 名称" },
        navi_type: {
          type: "string",
          enum: ["0", "1", "2"],
          description: "导航类型：0=驾车，1=步行，2=骑行",
        },
      },
      required: ["destination"],
    },
    statusText: (params) => {
      const destination = typeof params.destination === "string" ? params.destination : "目标地点";
      return `正在导航到 ${destination}...`;
    },
  },
  {
    name: "calendar",
    command: "control_calendar",
    description: "在灵珠设备上创建日程提醒。当用户要求添加日程、设置提醒、安排事项时，必须调用此工具。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "日程标题" },
        start_time: { type: "string", description: "开始时间，格式：YYYY-MM-DD HH:mm" },
        end_time: { type: "string", description: "结束时间，格式：YYYY-MM-DD HH:mm" },
      },
      required: ["title", "start_time"],
    },
    statusText: (params) => {
      const title = typeof params.title === "string" ? params.title : "日程";
      return `已创建日程：${title}`;
    },
  },
  {
    name: "exit_agent",
    command: "notify_agent_off",
    description: "退出当前智能体会话，返回灵珠主界面。当用户明确要求退出、结束对话时，才调用此工具。注意：在连续模式下，即使调用了拍照、录像等功能，也不要调用此工具，保持智能体连接。",
    parameters: EMPTY_PARAMS,
    statusText: () => "正在退出智能体...",
  },
  {
    name: "send_notification",
    command: "send_notification",
    description: "向眼镜发送通知，可选同步 TTS 播报。实验性原生动作。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "通知内容" },
        play_tts: { type: "boolean", description: "是否同步播报 TTS" },
        icon_type: { type: "string", description: "图标类型，默认 1" },
      },
      required: ["content"],
    },
    experimental: true,
    statusText: () => "已向眼镜发送通知",
  },
  {
    name: "send_toast",
    command: "send_toast",
    description: "向眼镜发送轻提示 Toast。实验性原生动作。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Toast 内容" },
        play_tts: { type: "boolean", description: "是否同步播报 TTS" },
        icon_type: { type: "string", description: "图标类型，默认 1" },
      },
      required: ["content"],
    },
    experimental: true,
    statusText: () => "已向眼镜发送提示",
  },
  {
    name: "speak_tts",
    command: "speak_tts",
    description: "在眼镜端直接播报一段文本。实验性原生动作。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "播报内容" },
      },
      required: ["content"],
    },
    experimental: true,
    statusText: () => "正在播报文本",
  },
  {
    name: "start_video_record",
    command: "start_video_record",
    description: "开始眼镜录像。实验性原生动作。在连续模式下，开始录像后智能体不会退出。",
    parameters: {
      type: "object",
      properties: {
        duration_sec: { type: "number", description: "录像时长，单位秒" },
        width: { type: "number", description: "录像宽度" },
        height: { type: "number", description: "录像高度" },
        quality: { type: "number", description: "画质或质量" },
      },
      required: [],
    },
    experimental: true,
    statusText: () => "正在开始录像",
  },
  {
    name: "stop_video_record",
    command: "stop_video_record",
    description: "停止眼镜录像。实验性原生动作。在连续模式下，停止录像后智能体不会退出。",
    parameters: EMPTY_PARAMS,
    experimental: true,
    statusText: () => "正在停止录像",
  },
  {
    name: "open_custom_view",
    command: "open_custom_view",
    description: "打开眼镜上的实验性自定义页面。实验性原生动作。",
    parameters: {
      type: "object",
      properties: {
        view_name: { type: "string", description: "页面名称" },
        view_payload: { type: "string", description: "页面 JSON 或配置字符串" },
      },
      required: ["view_name"],
    },
    experimental: true,
    statusText: () => "正在打开自定义页面",
  },
  // 新增连续模式工具
  {
    name: "enable_continuous_mode",
    command: "enable_continuous_mode",
    description: "启用连续对话模式。启用后智能体不会自动退出，可以持续交互，支持切换功能（如拍照、录像）而不退出。当用户要求保持连接、不要退出、连续对话时调用。",
    parameters: {
      type: "object",
      properties: {
        timeout_ms: { 
          type: "number", 
          description: "连续模式超时时间（毫秒），默认300000（5分钟）",
          default: 300000
        },
        keep_tools_active: { 
          type: "boolean", 
          description: "是否保持工具调用后仍然活跃",
          default: true
        },
      },
      required: [],
    },
    statusText: (params) => {
      const timeout = typeof params.timeout_ms === "number" ? params.timeout_ms : 300000;
      return `已启用连续对话模式，超时时间：${timeout / 1000}秒`;
    },
  },
  {
    name: "disable_continuous_mode",
    command: "disable_continuous_mode",
    description: "禁用连续对话模式，恢复默认行为。当用户要求允许退出或结束连续对话时调用。",
    parameters: EMPTY_PARAMS,
    statusText: () => "已禁用连续对话模式",
  },
  // 新增答题模式工具
  {
    name: "enter_quiz_mode",
    command: "enter_quiz_mode",
    description: "进入答题模式。系统会自动连续拍照识别题目内容，用户可以连续答题而无需重复唤醒智能体。当用户要求进入答题模式、开始答题、连续拍照答题时调用。",
    parameters: {
      type: "object",
      properties: {
        auto_capture: { 
          type: "boolean", 
          description: "是否自动连续拍照",
          default: true
        },
        capture_interval_ms: { 
          type: "number", 
          description: "自动拍照间隔（毫秒），默认5000",
          default: 5000
        },
        max_captures: { 
          type: "number", 
          description: "最大拍照次数，默认10",
          default: 10
        },
      },
      required: [],
    },
    statusText: (params) => {
      const interval = typeof params.capture_interval_ms === "number" ? params.capture_interval_ms : 5000;
      const maxCaptures = typeof params.max_captures === "number" ? params.max_captures : 10;
      return `已进入答题模式，将每隔${interval / 1000}秒自动拍照，最多${maxCaptures}次`;
    },
  },
  {
    name: "exit_quiz_mode",
    command: "exit_quiz_mode",
    description: "退出答题模式，停止自动拍照。当用户要求退出答题、停止答题时调用。",
    parameters: EMPTY_PARAMS,
    statusText: () => "已退出答题模式",
  },
  {
    name: "capture_and_read",
    command: "capture_and_read",
    description: "拍照并识别图片中的文字内容。在答题模式下自动调用，也可手动触发。",
    parameters: {
      type: "object",
      properties: {
        ocr_enabled: { 
          type: "boolean", 
          description: "是否启用OCR识别",
          default: true
        },
        question_text: { 
          type: "string", 
          description: "预期问题文本（可选）" 
        },
      },
      required: [],
    },
    statusText: () => "正在拍照并识别文字...",
  },
];

function getLingzhuToolDefinitions(enableExperimentalNativeActions: boolean): LingzhuToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => enableExperimentalNativeActions || tool.experimental !== true);
}

function encodeMarkerParams(params: unknown): string {
  return Buffer.from(JSON.stringify(params ?? {}), "utf8").toString("base64url");
}

function formatToolMarker(command: LingzhuToolCall["command"], params: unknown): string {
  return `@@@LINGZHU_TOOL:${command}:${encodeMarkerParams(params)}@@@`;
}

export function createLingzhuToolSchemas(enableExperimentalNativeActions = false) {
  return getLingzhuToolDefinitions(enableExperimentalNativeActions).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function createLingzhuTools(enableExperimentalNativeActions = false) {
  return getLingzhuToolDefinitions(enableExperimentalNativeActions).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id: string, params: Record<string, any>, ctx?: any): Promise<ToolExecuteResult> {
      console.log(`[Lingzhu:Native] Tool execute called for ${tool.name} with params:`, params);
      console.log(`[Lingzhu:Native] Context (ctx) provided:`, ctx);

      const marker = formatToolMarker(tool.command, params);
      const statusText = tool.statusText?.(params) ?? "";

      try {
        const parsedToolCall = parseToolCallFromAccumulated(tool.name, JSON.stringify(params), {
          enableExperimentalNativeActions
        });

        console.log(`[Lingzhu:Native] Parsed Tool Call:`, parsedToolCall);

        if (parsedToolCall) {
          const sessionKey = ctx?.user || ctx?.session?.user || ctx?.sessionKey || ctx?.sessionId;
          const agentId = ctx?.agentId || ctx?.agent_id;

          const emitPayload = {
            sessionKey,
            agentId,
            tool_call: parsedToolCall
          };
          console.log(`[Lingzhu:Native] Emitting native_invoke with payload:`, emitPayload);

          lingzhuEventBus.emit("native_invoke", emitPayload);
        } else {
          console.log(`[Lingzhu:Native] Failed to parse tool call from command ${tool.name}`);
        }
      } catch (err) {
        console.error(`[Lingzhu:Native] Error during execute parsing:`, err);
      }

      return {
        content: [
          {
            type: "text",
            text: statusText ? `${marker} ${statusText}` : marker,
          },
        ],
      };
    },
  }));
}