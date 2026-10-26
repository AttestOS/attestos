/**
 * AttestOS - Autonomous Dynamic Policy Tuning Engine
 * 
 * Works 100% without human admin oversight:
 * - Monitors attack velocity & anomaly density in real time
 * - Self-escalates defense difficulty when attack waves hit
 * - Automatically relaxes back to frictionless mode when traffic is clean
 * - Zero maintenance for the business operator
 */

class AutoTuner {
  constructor() {
    this.trafficWindows = new Map(); // siteKey -> [{ timestamp, isBot }]
    this.surgeThreshold = 10; // 10 bot detections within 30 seconds triggers surge mode
    this.windowDurationMs = 30000; // 30 seconds
  }

  /**
   * Record traffic event and dynamically determine difficulty adjustment
   */
  processTrafficSignal(siteKey, isSuspiciousBot) {
    const now = Date.now();
    let events = this.trafficWindows.get(siteKey) || [];

    // Filter events older than window duration
    events = events.filter(e => now - e.timestamp < this.windowDurationMs);
    events.push({ timestamp: now, isBot: isSuspiciousBot });
    this.trafficWindows.set(siteKey, events);

    // Calculate velocity
    const botCount = events.filter(e => e.isBot).length;
    const isUnderAttack = botCount >= this.surgeThreshold;

    let dynamicDifficultyAdjustment = 0;
    let mode = 'NORMAL';

    if (isUnderAttack) {
      dynamicDifficultyAdjustment = 2; // +2 difficulty = 256x harder
      mode = 'AUTONOMOUS_UNDER_ATTACK_MITIGATION';
    } else if (botCount >= 5) {
      dynamicDifficultyAdjustment = 1; // +1 difficulty = 16x harder
      mode = 'ELEVATED_FRICTION_MODE';
    }

    return {
      mode,
      isUnderAttack,
      botCountInWindow: botCount,
      dynamicDifficultyAdjustment,
      statusMessage: isUnderAttack 
        ? '⚠️ Autonomous defense: High-frequency bot cluster detected. Difficulty auto-scaled 256x.'
        : '✅ Normal operational baseline: Frictionless verification active.'
    };
  }
}

module.exports = new AutoTuner();
