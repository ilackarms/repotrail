import * as vscode from "vscode";
import { narrationAt, readingTimeMs } from "../engine/slides/timeline";
import { narrationTargetKey } from "../tts/playbackPolicy";
import type { TtsManager } from "../tts/manager";
import type { TourController } from "./tourController";
import type { WebviewTtsState } from "./renderPolicy";

/** Pause between one position's narration ending and the next starting. */
const GAP_MS = 700;

/**
 * Plays the tour hands-free: narrate the current position (a stop, or a
 * slide's beat), wait for the narration to end, move on, repeat. With
 * narration off or unavailable it waits a reading time instead. Moving by hand
 * while it plays continues from the new position.
 */
export class Autoplay implements vscode.Disposable {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waitingFor: string | null = null;
  private narrated: string | null = null;
  private moving = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly activeEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeActive = this.activeEmitter.event;

  constructor(
    private readonly controller: TourController,
    private readonly tts: TtsManager,
    private readonly log: vscode.OutputChannel,
  ) {
    this.subscriptions.push(
      tts.onDidFinish((key) => this.finished(key)),
      controller.onDidChange(() => this.changed()),
    );
  }

  get isActive(): boolean {
    return this.active;
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  start(): void {
    if (this.active) return;
    if (!this.controller.snapshot().plan) {
      void vscode.window.showInformationMessage("RepoTrail: open a tour to play it.");
      return;
    }
    this.setActive(true);
    this.log.appendLine("[autoplay] started");
    this.narrate();
  }

  stop(): void {
    if (!this.active) return;
    this.clearTimer();
    this.waitingFor = null;
    this.tts.cancel();
    this.setActive(false);
    this.log.appendLine("[autoplay] stopped");
  }

  /** Narration paused in the sidebar: wait for it instead of timing out. */
  ttsStateChanged(state: WebviewTtsState): void {
    if (!this.active || !this.waitingFor) return;
    if (state === "paused") this.clearTimer();
    else if (state === "playing" && !this.timer) this.armSafetyTimer(this.currentText());
  }

  dispose(): void {
    this.clearTimer();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.activeEmitter.dispose();
  }

  private setActive(active: boolean): void {
    this.active = active;
    void vscode.commands.executeCommand("setContext", "repoTrail.autoplaying", active);
    this.activeEmitter.fire(active);
  }

  private currentKey(): string | null {
    const snap = this.controller.snapshot();
    return narrationTargetKey(this.controller.activeTourId, snap.current, snap.beat);
  }

  private currentText(): string {
    const snap = this.controller.snapshot();
    return snap.current ? narrationAt(snap.current, snap.beat) : "";
  }

  private narrate(): void {
    this.clearTimer();
    if (!this.controller.snapshot().current) {
      this.stop();
      return;
    }
    this.narrated = this.currentKey();
    const text = this.currentText();
    if (this.tts.speakCurrent()) {
      this.waitingFor = this.narrated;
      this.armSafetyTimer(text);
    } else {
      // Nothing to hear: give the reader time, then move on.
      this.waitingFor = null;
      this.timer = setTimeout(() => void this.advance(), readingTimeMs(text));
    }
  }

  /** In case the end of narration never arrives (audio blocked, sidebar closed). */
  private armSafetyTimer(text: string): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.log.appendLine("[autoplay] narration didn't report an end; moving on");
      void this.advance();
    }, readingTimeMs(text) * 3 + 15000);
  }

  private finished(key: string | null): void {
    if (!this.active || key === null || key !== this.waitingFor) return;
    this.waitingFor = null;
    this.clearTimer();
    this.timer = setTimeout(() => void this.advance(), GAP_MS);
  }

  private async advance(): Promise<void> {
    if (!this.active) return;
    this.clearTimer();
    const snap = this.controller.snapshot();
    const atEnd = !snap.plan || (snap.index >= snap.plan.steps.length - 1 && snap.beat >= snap.positions - 1);
    if (atEnd) {
      this.stop();
      return;
    }
    this.moving = true;
    try {
      await this.controller.next();
    } finally {
      this.moving = false;
    }
    if (this.active) this.narrate();
  }

  private changed(): void {
    if (!this.active || this.moving) return;
    if (!this.controller.snapshot().plan) {
      this.stop();
      return;
    }
    // The user moved while playing: narrate from where they are.
    if (this.currentKey() !== this.narrated) {
      this.clearTimer();
      this.waitingFor = null;
      this.timer = setTimeout(() => {
        if (this.active) this.narrate();
      }, 250);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
