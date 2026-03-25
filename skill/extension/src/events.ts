import { EventEmitter } from "node:events";
import type { SessionState, QuizModeState, LingzhuConfig } from "./types.js";

/**
 * 灵珠事件总线
 */
export const lingzhuEventBus = new EventEmitter();

/**
 * 会话管理器 - 用于跟踪和管理连续对话和答题模式
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private config: LingzhuConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: LingzhuConfig) {
    this.config = config;
    this.startCleanupInterval();
  }

  /**
   * 更新配置
   */
  updateConfig(config: LingzhuConfig): void {
    this.config = config;
  }

  /**
   * 启动清理定时器
   */
  private startCleanupInterval(): void {
    // 每30秒清理一次过期会话
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 30000);
  }

  /**
   * 停止清理定时器
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 获取或创建会话
   */
  getOrCreateSession(sessionKey: string, agentId: string): SessionState {
    let session = this.sessions.get(sessionKey);
    
    if (!session) {
      session = {
        sessionKey,
        agentId,
        lastActivityTime: Date.now(),
        isActive: true,
        isInQuizMode: false,
        continuousModeConfig: {
          timeoutMs: this.config.continuousModeTimeoutMs || 300000,
          lastHeartbeat: Date.now(),
        },
      };
      this.sessions.set(sessionKey, session);
    } else {
      // 更新活动时间
      session.lastActivityTime = Date.now();
      if (session.continuousModeConfig) {
        session.continuousModeConfig.lastHeartbeat = Date.now();
      }
    }
    
    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionKey: string): SessionState | undefined {
    const session = this.sessions.get(sessionKey);
    if (session) {
      // 检查是否过期
      if (this.isSessionExpired(session)) {
        this.sessions.delete(sessionKey);
        return undefined;
      }
      session.lastActivityTime = Date.now();
    }
    return session;
  }

  /**
   * 检查会话是否过期
   */
  private isSessionExpired(session: SessionState): boolean {
    if (!session.continuousModeConfig) {
      return false; // 非连续模式不过期
    }
    
    const elapsed = Date.now() - session.continuousModeConfig.lastHeartbeat;
    return elapsed > session.continuousModeConfig.timeoutMs;
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (!session.isActive) {
        this.sessions.delete(key);
        continue;
      }
      
      // 检查连续模式超时
      if (session.continuousModeConfig) {
        const elapsed = now - session.continuousModeConfig.lastHeartbeat;
        if (elapsed > session.continuousModeConfig.timeoutMs) {
          session.isActive = false;
          this.sessions.delete(key);
          lingzhuEventBus.emit("session_expired", { sessionKey: key, agentId: session.agentId });
        }
      }
    }
  }

  /**
   * 进入答题模式
   */
  enterQuizMode(sessionKey: string, agentId: string): SessionState {
    const session = this.getOrCreateSession(sessionKey, agentId);
    session.isInQuizMode = true;
    session.quizModeConfig = {
      captureCount: 0,
      maxCaptures: this.config.quizModeMaxCaptures || 10,
      intervalMs: this.config.quizModeCaptureIntervalMs || 5000,
      lastCaptureTime: 0,
      pendingAnswer: false,
      capturedTexts: [],
    };
    
    // 延长连续模式时间
    if (session.continuousModeConfig) {
      session.continuousModeConfig.timeoutMs = Math.max(
        session.continuousModeConfig.timeoutMs,
        600000 // 答题模式至少保持10分钟
      );
    }
    
    lingzhuEventBus.emit("quiz_mode_entered", { sessionKey, agentId });
    return session;
  }

  /**
   * 退出答题模式
   */
  exitQuizMode(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.isInQuizMode = false;
      session.quizModeConfig = undefined;
      lingzhuEventBus.emit("quiz_mode_exited", { sessionKey, agentId: session.agentId });
    }
  }

  /**
   * 更新答题模式状态
   */
  updateQuizMode(sessionKey: string, update: Partial<NonNullable<SessionState["quizModeConfig"]>>): void {
    const session = this.sessions.get(sessionKey);
    if (session && session.quizModeConfig) {
      Object.assign(session.quizModeConfig, update);
    }
  }

  /**
   * 启用连续模式
   */
  enableContinuousMode(sessionKey: string, agentId: string, timeoutMs?: number): SessionState {
    const session = this.getOrCreateSession(sessionKey, agentId);
    session.continuousModeConfig = {
      timeoutMs: timeoutMs || this.config.continuousModeTimeoutMs || 300000,
      lastHeartbeat: Date.now(),
    };
    return session;
  }

  /**
   * 禁用连续模式
   */
  disableContinuousMode(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.continuousModeConfig = undefined;
      session.isActive = false;
    }
  }

  /**
   * 获取所有活跃会话
   */
  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values()).filter(s => s.isActive);
  }

  /**
   * 检查是否需要自动拍照
   */
  shouldAutoCapture(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.isInQuizMode || !session.quizModeConfig) {
      return false;
    }

    const now = Date.now();
    const config = session.quizModeConfig;
    
    // 检查是否超过最大次数
    if (config.captureCount >= config.maxCaptures) {
      return false;
    }
    
    // 检查间隔时间
    if (now - config.lastCaptureTime < config.intervalMs) {
      return false;
    }
    
    // 检查是否正在等待上一个答案
    if (config.pendingAnswer) {
      return false;
    }
    
    return true;
  }

  /**
   * 记录拍照
   */
  recordCapture(sessionKey: string, recognizedText?: string): void {
    const session = this.sessions.get(sessionKey);
    if (session && session.quizModeConfig) {
      session.quizModeConfig.captureCount++;
      session.quizModeConfig.lastCaptureTime = Date.now();
      session.quizModeConfig.pendingAnswer = true;
      if (recognizedText) {
        session.quizModeConfig.capturedTexts.push(recognizedText);
      }
    }
  }

  /**
   * 记录答案完成
   */
  recordAnswerComplete(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session && session.quizModeConfig) {
      session.quizModeConfig.pendingAnswer = false;
    }
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.stop();
    this.sessions.clear();
  }
}

// 全局会话管理器实例
let globalSessionManager: SessionManager | null = null;

export function getSessionManager(config?: LingzhuConfig): SessionManager {
  if (!globalSessionManager && config) {
    globalSessionManager = new SessionManager(config);
  } else if (globalSessionManager && config) {
    globalSessionManager.updateConfig(config);
  }
  
  if (!globalSessionManager) {
    throw new Error("SessionManager not initialized");
  }
  
  return globalSessionManager;
}

export function resetSessionManager(): void {
  if (globalSessionManager) {
    globalSessionManager.destroy();
    globalSessionManager = null;
  }
}