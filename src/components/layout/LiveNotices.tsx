import { useEffect, useRef, useState } from "preact/hooks";
import { IconCrossMedium } from "../icons";
import { useUiSignal } from "../../core/ui/uiSignals.ts";
import { motionDuration } from "../../core/ui/motion.ts";
import {
  dismissGlobalNotice,
  liveNoticesSignal,
  sendGlobalNoticeAction,
  type LiveNotice,
} from "../../features/ui/globalNotice.ts";
import "../../assets/styles/notice/notice.css";

interface Burst {
  key: number;
  index: number;
  drift: number;
}

let burstKey = 0;

function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    const duration = motionDuration("reveal") * 2;
    if (start === value || !duration) {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / duration);
      const current = Math.round(start + (value - start) * (1 - (1 - progress) ** 3));
      from.current = current;
      setShown(current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{shown}</>;
}

function NoticePoll({ notice }: { notice: LiveNotice }) {
  const total = notice.tally.votes.reduce((sum, count) => sum + count, 0);
  const voted = notice.mine.vote >= 0;
  return (
    <div class={`live-notice-poll${voted ? " voted" : ""}`} role="group" aria-label="poll">
      {notice.poll!.map((option, index) => {
        const chosen = notice.mine.vote === index;
        const share = total ? Math.round((notice.tally.votes[index]! / total) * 100) : 0;
        return (
          <button
            type="button"
            key={option}
            class={`live-notice-option${chosen ? " chosen" : ""}`}
            style={`--option-index:${index};--option-share:${voted ? share / 100 : 0}`}
            aria-pressed={chosen}
            onClick={() => void sendGlobalNoticeAction(notice.id, { vote: index })}
          >
            <span class="live-notice-fill" aria-hidden="true" />
            <span class="live-notice-option-label">{option}</span>
            <span class="live-notice-share" aria-hidden={!voted}>
              <CountUp value={voted ? share : 0} />%
            </span>
          </button>
        );
      })}
      <span class="live-notice-meta">
        {total} {total === 1 ? "vote" : "votes"}
      </span>
    </div>
  );
}

function NoticeReactions({ notice }: { notice: LiveNotice }) {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const previous = useRef(notice.tally.reactions);
  const mineBefore = useRef(notice.mine.reactions);

  useEffect(() => {
    const added: Burst[] = [];
    notice.tally.reactions.forEach((count, index) => {
      const own = notice.mine.reactions.includes(index) && !mineBefore.current.includes(index) ? 1 : 0;
      const others = count - (previous.current[index] ?? 0) - own;
      for (let n = 0; n < Math.min(others, 3); n++) {
        added.push({ key: ++burstKey, index, drift: Math.round(Math.random() * 16 - 8) });
      }
    });
    previous.current = notice.tally.reactions;
    mineBefore.current = notice.mine.reactions;
    if (added.length) setBursts((current) => [...current, ...added].slice(-12));
  }, [notice.tally.reactions, notice.mine.reactions]);

  const settle = (key: number) => setBursts((current) => current.filter((burst) => burst.key !== key));

  return (
    <div class="live-notice-reactions" role="group" aria-label="reactions">
      {notice.reactions.map((emoji, index) => {
        const active = notice.mine.reactions.includes(index);
        const count = notice.tally.reactions[index]!;
        return (
          <button
            type="button"
            key={emoji}
            class={`live-notice-reaction${active ? " active" : ""}`}
            aria-pressed={active}
            aria-label={`${emoji} ${count}`}
            onClick={() => void sendGlobalNoticeAction(notice.id, { react: index })}
          >
            <span class="live-notice-emoji">{emoji}</span>
            {count > 0 && <span class="live-notice-count">{count}</span>}
            {bursts
              .filter((burst) => burst.index === index)
              .map((burst) => (
                <span
                  key={burst.key}
                  class="live-notice-burst"
                  style={`--burst-drift:${burst.drift}px`}
                  aria-hidden="true"
                  onAnimationEnd={() => settle(burst.key)}
                >
                  {emoji}
                </span>
              ))}
          </button>
        );
      })}
    </div>
  );
}

function NoticeCard({ notice }: { notice: LiveNotice }) {
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(notice.ms);
  const startedAt = useRef(0);

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => dismissGlobalNotice(notice.id), motionDuration("exit") + 50);
  };

  useEffect(() => {
    if (paused || leaving) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(leave, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, leaving]);

  return (
    <div
      class={`live-notice${leaving ? " leaving" : ""}${paused ? " paused" : ""}`}
      role="status"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusIn={() => setPaused(true)}
      onFocusOut={() => setPaused(false)}
    >
      <p class="live-notice-text">{notice.text}</p>
      {notice.poll && <NoticePoll notice={notice} />}
      {notice.reactions.length > 0 && <NoticeReactions notice={notice} />}
      <span class="live-notice-timer" style={{ animationDuration: `${notice.ms}ms` }} aria-hidden="true" />
      <button type="button" class="modal-close-btn" aria-label="dismiss" onClick={leave}>
        <IconCrossMedium />
      </button>
    </div>
  );
}

export default function LiveNotices() {
  const notices = useUiSignal(liveNoticesSignal);
  if (!notices.length) return null;
  return (
    <div class="live-notices">
      {[...notices].reverse().map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
