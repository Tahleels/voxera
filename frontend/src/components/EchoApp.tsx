"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Capabilities, EchoState, RecentProduct } from "@/types";
import { callTool, getAllProducts, getCapabilities, getState, getVoiceSetup, newSession, postTurn } from "@/lib/api";
import { ensureSessionId } from "@/lib/session";
import { fallbackSpeak, startRecording, type RecordingHandle } from "@/lib/audio";
import { VoiceAgentSession, type AgentStatus } from "@/lib/voiceAgent";
import { usePrefs } from "@/lib/prefs";
import { useAudioMeter, usePhaseView } from "@/lib/agentState";
import { useTranscript } from "@/lib/transcript";
import { LiveRegion } from "./LiveRegion";
import { ConnectScreen } from "./ConnectScreen";
import { AgentCore } from "./AgentCore";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ProductList } from "./ProductList";
import { CartPanel } from "./CartPanel";
import { CheckoutPanel } from "./CheckoutPanel";

/** Tool results worth hearing, phrased by the server rather than by us. */
const ANNOUNCED_TOOLS = new Set([
  "addToCart",
  "removeFromCart",
  "applyCoupon",
  "checkout",
  "checkout_preview",
]);

const EMPTY_CART: EchoState["cart"] = {
  isEmpty: true,
  lines: [],
  subtotal: 0,
  discountPercent: 0,
  discount: 0,
  total: 0,
  linesText: "",
  couponCode: null,
};

export function EchoApp() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [echoState, setEchoState] = useState<EchoState | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [fillerText, setFillerText] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [speaking, setSpeaking] = useState(false);
  /**
   * Whether the server's voice-activity detection currently says the user is
   * talking. The agent reports the `listening` status both when it is idly
   * waiting and while someone is speaking, so this is the only signal that can
   * tell those two states apart honestly.
   */
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [micUnsupported, setMicUnsupported] = useState(false);
  /**
   * A shutdown has been asked for but the socket is still closing. It buys the
   * core a short, visible settling period instead of the picture cutting to
   * "not connected" in a single frame, and it keeps a second click from opening
   * a second connection while the first is still tearing down.
   */
  const [deactivating, setDeactivating] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [dismissedOrder, setDismissedOrder] = useState<string | null>(null);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("echo_wishlist") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const [zoomLevel, setZoomLevel] = useState<number>(() => {
    try { return Number(localStorage.getItem("echo_zoom") ?? "1") || 1; }
    catch { return 1; }
  });
  const [allCatalogProducts, setAllCatalogProducts] = useState<RecentProduct[]>([]);
  const [catalogCategory, setCatalogCategory] = useState<string | null>(null);

  const prefs = usePrefs();
  const { reducedMotion } = prefs;
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  const transcript = useTranscript();
  const demoRecordingHandle = useRef<RecordingHandle | null>(null);
  const voiceSession = useRef<VoiceAgentSession | null>(null);
  // Interaction lock for the core. A ref, not state: the guard has to be true
  // within the same tick as the click, before React has rendered anything.
  const toggleLock = useRef(false);
  const settleTimer = useRef<number | null>(null);
  // The long-lived voice session closes over this once, so it must read the
  // latest state through a ref rather than a stale render closure.
  const stateRef = useRef<EchoState | null>(null);
  stateRef.current = echoState;

  const voiceAgent = caps?.voiceAgent ?? false;
  const effectiveBusy = voiceAgent
    ? agentStatus === "connecting" || agentStatus === "thinking"
    : busy;

  const phaseView = usePhaseView({
    connected,
    agentStatus,
    recording,
    busy: effectiveBusy,
    speaking,
    filler: Boolean(fillerText),
    deactivating,
    userSpeaking,
  });

  /**
   * The level fed to the core comes from the matching direction only: the
   * microphone while the user is talking, the speaker while the agent is. When
   * there is no audio in that direction the level is `null`, and the core is
   * driven by its own slow breath rather than an invented meter.
   */
  // Audio is written into a shared box, not state: it arrives on every frame
  // and only the core reads it, so keeping it in state would re-render the
  // products, the cart and the transcript sixty times a second for nothing.
  const audio = useAudioMeter();

  /* ---- sizing: the core is measured from its own box, never the window ---- */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(768);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const read = () => setViewportHeight(window.innerHeight);
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);

  const voiceProducts = echoState?.recentProducts ?? [];

  // Filtered catalog for direct browsing. Voice results take the top spots;
  // rest of catalog fills below (deduplicated by id).
  const voiceIds = new Set(voiceProducts.map((p) => p.id));
  const filteredCatalog = allCatalogProducts.filter(
    (p) => !voiceIds.has(p.id) && (!catalogCategory || p.category === catalogCategory)
  );
  const products = [...voiceProducts, ...filteredCatalog];
  const hasResults = products.length > 0;
  const order = echoState?.lastOrder ?? null;
  const showOrder = order !== null && order.id !== dismissedOrder;

  /**
   * The core is sized to be genuinely dominant: roughly 46% of the viewport
   * height before results arrive, easing to 40% once there is a grid below it.
   * It eases rather than snaps so a long conversation never leaves a small
   * circle stranded at the top of the page.
   */
  const coreSize = useMemo(() => {
    const available = stageWidth > 0 ? stageWidth : 320;
    const byHeight = viewportHeight * (hasResults ? 0.4 : 0.46);
    const byWidth = available * 0.78;
    return Math.round(Math.max(200, Math.min(byHeight, byWidth, 520)));
  }, [stageWidth, viewportHeight, hasResults]);

  useEffect(() => {
    setMicUnsupported(
      typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia
    );
  }, []);

  /* ---- boot: capabilities, session, state ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [capabilities, id, catalog] = await Promise.all([
          getCapabilities().catch(() => null),
          ensureSessionId(newSession),
          getAllProducts().catch(() => [] as RecentProduct[]),
        ]);
        if (cancelled) return;
        setCaps(capabilities);
        setSessionId(id);
        setAllCatalogProducts(catalog);

        // Fetch the session state. The auth cookie was just set by the POST in
        // ensureSessionId; if it hasn't propagated yet the first call can 401,
        // so retry once. A transient failure here must not blank the whole app —
        // products and demo mode still work — so it is best-effort, not fatal.
        let s = await getState().catch(() => null);
        if (!s) {
          await new Promise((r) => setTimeout(r, 400));
          s = await getState().catch(() => null);
        }
        if (!cancelled && s) {
          const freshState: EchoState = {
            ...s,
            recentProducts: [],
          };
          stateRef.current = freshState;
          setEchoState(freshState);
        }
      } catch {
        if (!cancelled)
          setNotice({
            text: "I couldn't reach the shopping service. Please reload the page.",
            tone: "error",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      voiceSession.current?.end();
    },
    []
  );

  const refreshState = useCallback(async () => {
    const s = await getState().catch(() => null);
    if (s) {
      stateRef.current = s;
      setEchoState(s);
    }
  }, []);

  /**
   * Highlight whichever product the agent is currently describing. Matching uses
   * the agent's own words, because that is the only signal available without
   * changing the agent: the product it just named is the one it is talking
   * about. A direct tool result takes precedence over the text match.
   */
  const spotlightFromText = useCallback((text: string): string | null => {
    const list = stateRef.current?.recentProducts ?? [];
    if (list.length === 0) return null;
    const said = text.toLowerCase();
    let best: { id: string; score: number } | null = null;
    for (const p of list) {
      const name = p.name.toLowerCase();
      if (!name || !said.includes(name)) continue;
      // Prefer the most specific name, so a longer product wins over a substring.
      if (!best || name.length > best.score) best = { id: p.id, score: name.length };
    }
    return best ? best.id : null;
  }, []);

  const focusSpotlight = useCallback((name: string | undefined) => {
    if (!name) return;
    const needle = name.toLowerCase();
    const match = (stateRef.current?.recentProducts ?? []).find(
      (p) => p.name.toLowerCase() === needle
    );
    if (match) setSpotlightId(match.id);
  }, []);

  const ensureVoice = useCallback(async (): Promise<VoiceAgentSession> => {
    const existing = voiceSession.current;
    if (existing && existing.isReady) return existing;
    if (existing) existing.end();
    if (!sessionId) throw new Error("no app session yet");

    const setup = await getVoiceSetup();
    const session = new VoiceAgentSession(
      setup,
      async (name, args) => callTool(name, args),
      {
        onStatus: (status) => setAgentStatus(status),
        onUserTurnStart: () => {
          setUserSpeaking(true);
          transcript.sealOpen("user");
        },
        onUserTranscript: (text, final, mode) => {
          const clean = text.trim();
          if (!clean) return;
          if (final) {
            setUserSpeaking(false);
            transcript.commit("user", clean);
          } else if (mode === "cumulative") {
            transcript.setPartial("user", clean);
          } else {
            transcript.appendPartial("user", clean);
          }
        },
        onAgentTranscript: (text, final, _interrupted, mode) => {
          const clean = text.trim();
          if (!clean) return;
          if (final) transcript.commit("agent", clean);
          else if (mode === "cumulative") transcript.setPartial("agent", clean);
          else transcript.appendPartial("agent", clean);
          // Track the product as it is described, not only at the end, so the card
          // lifts while Echo is still talking about it.
          setSpotlightId(spotlightFromText(clean));
        },
        onToolCall: ({ name, result }) => {
          if (result.success && ANNOUNCED_TOOLS.has(name)) {
            // The server already words these for speech; reuse it verbatim rather
            // than inventing a second description of what happened.
            setAnnouncement(result.message ?? "Done.");
          }
          focusSpotlight(
            typeof result.data?.productName === "string" ? result.data.productName : undefined
          );
          void refreshState();
        },
        onReplyDone: ({ interrupted }) => {
          transcript.closeAgentReply(interrupted);
          setUserSpeaking(false);
          if (interrupted) setAnnouncement("You interrupted Echo.");
          // The spotlight belongs to the utterance, so it clears when the reply
          // ends rather than leaving a stale card highlighted forever.
          if (!interrupted) setSpotlightId(null);
        },
        onSpeakingChange: setSpeaking,
        onAudioLevel: (level, source) => {
          audio.value = level;
          audio.source = level > 0 ? source : null;
        },
        onError: (message) => setNotice({ text: `Voice agent: ${message}`, tone: "error" }),
      }
    );
    voiceSession.current = session;
    await session.connect();
    return session;
    // `transcript` is a stable object of useCallback functions and the spotlight
    // helpers read through refs, so this is created once per session.
  }, [sessionId, refreshState, transcript, focusSpotlight, spotlightFromText]);

  const playReply = useCallback((reply: string, audioUrl: string | null) => {
    const speakFallback = () => fallbackSpeak(reply, { rate: 1, pitch: 1 });
    if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.play().catch(speakFallback);
    } else {
      speakFallback();
    }
  }, []);

  const runTurn = useCallback(
    async (input: { text?: string; audioBase64?: string }) => {
      if (!sessionId || !caps) return;

      /* ---- live mode: one AssemblyAI Voice Agent session ---- */
      if (caps.voiceAgent) {
        if (effectiveBusy) return;
        const text = input.text?.trim();
        if (!text) return;
        // A new turn supersedes whatever the last failure was warning about.
        setNotice(null);
        try {
          setConnected(true);
          const session = await ensureVoice();
          await session.input(text);
        } catch (err) {
          setNotice({
            text: `I couldn't reach the voice agent — ${
              err instanceof Error ? err.message : "unknown error"
            }. Try again.`,
            tone: "error",
          });
        }
        return;
      }

      /* ---- demo mode: text or recorded audio through the plain tool loop ---- */
      if (effectiveBusy) return;
      setNotice(null);
      setBusy(true);
      setFillerText("");
      try {
        const events = await postTurn(input);
        if (events.userText) {
          transcript.commit("user", events.userText);
        }
        if (events.filler) setFillerText(events.filler.text);
        if (events.reply) transcript.commit("agent", events.reply);
        if (events.state) {
          stateRef.current = events.state;
          setEchoState(events.state);
        }
        // The reply is NOT pushed to the live region here: the transcript already
        // announces the newest finished agent message, and two live regions
        // carrying the same sentence would read it out twice.
        if (events.reply) playReply(events.reply, events.audioUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setNotice({
          text: `I couldn't finish that — ${message}. Nothing was changed.`,
          tone: "error",
        });
      } finally {
        setBusy(false);
        setFillerText("");
      }
    },
    [caps, effectiveBusy, ensureVoice, playReply, transcript]
  );

  const handleConnect = useCallback(async () => {
    if (connected) return;
    setConnected(true);
    if (!voiceAgent) {
      setNotice({
        text: "There's no live voice agent configured, so nothing is listening yet. Use the microphone button to record a request, or type it below.",
        tone: "info",
      });
      return;
    }
    try {
      const session = await ensureVoice();
      await session.startMic();
      setRecording(true);
    } catch (err) {
      // Mic blocked or unavailable: the text box is the fallback, and the
      // interface must say so instead of appearing broken.
      setRecording(false);
      setNotice({
        text:
          err instanceof Error
            ? `I can't reach the microphone here — ${err.message}. Type your request instead.`
            : "I can't reach the microphone here. Type your request instead.",
        tone: "error",
      });
    }
  }, [connected, voiceAgent, ensureVoice]);

  const toggleMic = useCallback(async () => {
    if (effectiveBusy) return;
    if (recording) {
      setRecording(false);
      setUserSpeaking(false);
      if (voiceAgent) {
        voiceSession.current?.stopMic();
      } else {
        const handle = demoRecordingHandle.current;
        demoRecordingHandle.current = null;
        const audioBase64 = await handle?.stop();
        if (audioBase64) await runTurn({ audioBase64 });
        else
          setNotice({
            text: "I didn't capture any audio. Try again, or type your request.",
            tone: "info",
          });
      }
      return;
    }
    try {
      if (voiceAgent) {
        const session = await ensureVoice();
        await session.startMic();
        setRecording(true);
      } else {
        demoRecordingHandle.current = await startRecording();
        setRecording(true);
      }
    } catch {
      setNotice({
        text: "I can't reach the microphone here — type your request instead, or allow mic access and reload.",
        tone: "error",
      });
    }
  }, [effectiveBusy, recording, voiceAgent, ensureVoice, runTurn]);

  /**
   * Letting go of Echo.
   *
   * This closes the session that already exists — it never opens a second one.
   * The microphone is stopped first so nothing is still being captured while the
   * socket closes, and the `deactivating` state holds the core in view for a
   * moment so the transition is something you watch rather than a cut.
   */
  const handleDisconnect = useCallback(() => {
    if (!connected || toggleLock.current) return;
    toggleLock.current = true;
    setDeactivating(true);
    setUserSpeaking(false);
    setSpotlightId(null);
    setRecording(false);
    voiceSession.current?.stopMic();

    settleTimer.current = window.setTimeout(() => {
      voiceSession.current?.end();
      voiceSession.current = null;
      setConnected(false);
      setSpeaking(false);
      setAgentStatus(null);
      setDeactivating(false);
      toggleLock.current = false;
      settleTimer.current = null;
    }, 560);
  }, [connected]);

  /**
   * The sphere is the primary control: one gesture in, one gesture out.
   * The lock is the whole reason clicking cannot produce a second connection —
   * it is checked before anything is awaited, so a fast double click does
   * nothing the second time.
   */
  const handleSphereToggle = useCallback(() => {
    if (toggleLock.current) return;
    if (connected) {
      handleDisconnect();
      return;
    }
    toggleLock.current = true;
    void handleConnect().finally(() => {
      toggleLock.current = false;
    });
  }, [connected, handleConnect, handleDisconnect]);

  /**
   * The name of the core's button states the action it will take, so it is never
   * ambiguous which way a press will go. The state beside the core always says
   * the same thing in text for anyone who cannot see the button.
   */
  const coreLabel = deactivating
    ? "Disconnecting Echo voice assistant"
    : connected
      ? "Deactivate Echo voice assistant"
      : "Activate Echo voice assistant";

  // Inert while a connection is opening or closing, so the label never promises
  // an action the button would ignore.
  const coreLocked = deactivating || agentStatus === "connecting";

  const toggleWishlist = useCallback((product: RecentProduct) => {
    setWishlistIds((prev) => {
      const next = new Set(prev);
      if (next.has(product.id)) next.delete(product.id);
      else next.add(product.id);
      try { localStorage.setItem("echo_wishlist", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const lastActionType =
    echoState?.lastAction && typeof echoState.lastAction === "object"
      ? (echoState.lastAction as { type?: string }).type
      : undefined;
  const awaitingCheckoutConfirmation = lastActionType === "checkout_preview";

  const currency = caps?.currency ?? "INR";

  const statusLine = useMemo(() => {
    if (!caps) return "Checking what's available…";
    return `${voiceAgent ? "Live voice" : `Speech ${caps.stt ? "ready" : "off"}`} · ${
      caps.db === "mongodb" ? "database connected" : caps.db === "memory" ? "database in memory" : caps.db
    }`;
  }, [caps, voiceAgent]);

  const CATEGORIES = caps?.categories ?? [];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the voice controls
      </a>

      {/* Screen-reader announcements (tool results, notices) */}
      <LiveRegion
        text={`${announcement}${notice ? ` ${notice.text}` : ""}`}
        label="Action result"
        busy={effectiveBusy}
      />

      {/* ── Store header ─────────────────────────────────────────────────── */}
      <header className="masthead">
        <div className="masthead__brand">
          {/* Brand name with accent on last letter */}
          <p className="brand">Echo<span>.</span></p>
          <p className="masthead__status">{statusLine}</p>
        </div>

        {/* Decorative search slot — voice is the real search here */}
        <div className="masthead__search" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <span>Ask Echo to find anything…</span>
        </div>

        <div className="masthead__actions">
          {/* Magnifier slider — stretch to zoom in/out */}
          <div className="masthead__zoom" aria-label="Zoom controls">
            <span className="zoom-label" aria-hidden="true">A</span>
            <input
              type="range"
              className="zoom-slider"
              min={75}
              max={200}
              step={5}
              value={Math.round(zoomLevel * 100)}
              onChange={(e) => {
                const next = Number(e.target.value) / 100;
                setZoomLevel(next);
                try { localStorage.setItem("echo_zoom", String(next)); } catch {}
              }}
              aria-label={`Zoom level ${Math.round(zoomLevel * 100)}%`}
              title={`${Math.round(zoomLevel * 100)}%`}
            />
            <span className="zoom-label zoom-label--lg" aria-hidden="true">A</span>
          </div>

          {/* Wishlist count badge */}
          {wishlistIds.size > 0 && (
            <div className="masthead__wish-count" aria-label={`${wishlistIds.size} items saved`} title={`${wishlistIds.size} saved`}>
              <span aria-hidden="true">♥</span>
              <span>{wishlistIds.size}</span>
            </div>
          )}

          <CartPanel
            open={cartOpen}
            onOpen={() => setCartOpen(true)}
            onClose={() => setCartOpen(false)}
            cart={echoState?.cart ?? EMPTY_CART}
            currency={currency}
            busy={effectiveBusy}
            reducedMotion={reducedMotion}
            onRemove={(name) => void runTurn({ text: `remove the ${name} from my cart` })}
            onApplyCoupon={(code) => void runTurn({ text: `apply the coupon code ${code}` })}
            onCheckout={() => void runTurn({ text: "check out" })}
          />
        </div>
      </header>

      {/* ── Category chips bar ───────────────────────────────────────────── */}
      {CATEGORIES.length > 0 && (
        <nav className="categories-bar" aria-label="Browse by category">
          <ul className="categories-bar__inner">
            <li>
              <button
                type="button"
                className="category-chip"
                data-active={catalogCategory === null || undefined}
                onClick={() => setCatalogCategory(null)}
              >
                All
              </button>
            </li>
            {CATEGORIES.map((cat) => (
              <li key={cat}>
                <button
                  type="button"
                  className="category-chip"
                  data-active={catalogCategory === cat || undefined}
                  onClick={() => setCatalogCategory((prev) => prev === cat ? null : cat)}
                >
                  {cat}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <main id="main" className="app__content" style={{ "--content-scale": zoomLevel } as React.CSSProperties}>
        {/*
          The working stage. On a desktop this is two columns — the core and its
          state on the left, the live conversation and the input on the right —
          and it stacks into one column on a phone. The two live inside the same
          `zoom-region` as before, so magnification still re-lays out the stage
          rather than scaling it into a blurry overlay.
        */}
        {/* ── Hero banner — shown on landing before session starts ───────── */}
        {!connected && (
          <section className="hero zoom-region" aria-labelledby="hero-heading">
            <p className="hero__eyebrow">AssemblyAI Voice Agent</p>
            <h1 id="hero-heading" className="hero__heading">
              Shop with your voice,<br />hands-free.
            </h1>
            <p className="hero__sub">
              Echo understands what you need, finds it, and adds it to your cart —
              all in a natural conversation. Built for everyone, especially those
              who rely on voice.
            </p>
            <div className="hero__actions">
              <button
                type="button"
                className="btn btn--solid btn--hero"
                disabled={coreLocked || caps === null}
                onClick={() => void handleConnect()}
              >
                🎙 Start Voice Shopping
              </button>
            </div>
            <div className="hero__badge">
              <span className="hero__badge-dot" aria-hidden="true" />
              {voiceAgent ? "Live voice agent ready" : "Demo mode — type your request"}
            </div>
          </section>
        )}

        <div className="stage zoom-region">
          <div className="stage__core" ref={stageRef}>
            {/* One continuous object. Everything else is arranged around it, and
                it is never replaced when the state changes. */}
            <AgentCore
              phase={phaseView.phase}
              audio={audio}
              reducedMotion={reducedMotion}
              size={coreSize}
              active={connected}
              disabled={coreLocked}
              label={coreLabel}
              onToggle={handleSphereToggle}
            />

            <div className="stage__state">
              <p className="stage__label" data-phase={phaseView.phase}>
                {phaseView.label}
              </p>
              <p className="stage__detail">{phaseView.detail}</p>
              {/* The full sentence goes to assistive technology; the short word
                  above is what people can see. One live region, so each state is
                  heard once. */}
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {phaseView.spoken}
              </span>
            </div>

            <AnimatePresence>
              {!connected ? (
                <ConnectScreen
                  key="invite"
                  phase={phaseView.phase}
                  ready={caps !== null}
                  voiceAgent={voiceAgent}
                  micUnsupported={micUnsupported}
                  reducedMotion={reducedMotion}
                  onConnect={() => void handleConnect()}
                />
              ) : null}
            </AnimatePresence>
          </div>

          <div className="stage__side">
            <Transcript
              messages={transcript.messages}
              reducedMotion={reducedMotion}
              onClear={transcript.clear}
            />

            {/* Failures and guidance are visible, not only announced: the live
                region is invisible by design, so anything needing action also
                gets real text. It is not itself a live region, because the
                announcement above already read it out. */}
            {notice ? (
              <p className={`notice${notice.tone === "error" ? " notice--error" : ""}`}>
                {notice.text}
              </p>
            ) : null}

            <AnimatePresence>
              {connected ? (
                <motion.div
                  key="active"
                  className="stage__active"
                  initial={still ? { opacity: 0 } : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={still ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={{ duration: still ? 0.15 : 0.42, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Composer
                    connected={connected}
                    recording={recording}
                    busy={effectiveBusy}
                    reducedMotion={reducedMotion}
                    onStart={() => void toggleMic()}
                    onStop={() => void toggleMic()}
                    onSend={(text) => void runTurn({ text })}
                  />
                </motion.div>
              ) : (
                <motion.p
                  key="idle-hint"
                  className="stage__hint"
                  initial={still ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: still ? 0 : 0.3 }}
                >
                  Press the core to begin — it is also a button.
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/*
          Everything that is an outcome rather than an interaction: the checkout
          confirmation, the receipt and the products found so far. Below the stage,
          in that order, so the conversation is never displaced by results.
        */}
        <div className="below zoom-region">
          {awaitingCheckoutConfirmation ? (
            <div className="confirm" role="group" aria-label="Confirm checkout">
              <p className="confirm__text">
                Echo previewed your order. Nothing is placed until you confirm.
              </p>
              <button
                type="button"
                className="btn btn--solid"
                disabled={effectiveBusy}
                onClick={() => void runTurn({ text: "yes, place the order" })}
              >
                Yes, place the order
              </button>
            </div>
          ) : null}

          <CheckoutPanel
            order={showOrder ? order : null}
            currency={currency}
            reducedMotion={reducedMotion}
            onDismiss={() => setDismissedOrder(order?.id ?? null)}
          />

          <ProductList
            products={products}
            spotlightId={spotlightId}
            currency={currency}
            busy={effectiveBusy}
            wishlistIds={wishlistIds}
            reducedMotion={reducedMotion}
            onSelect={(p: RecentProduct) =>
              void runTurn({ text: `tell me more about the ${p.name}` })
            }
            onAdd={(p: RecentProduct) =>
              void runTurn({ text: `add the ${p.name} to my cart` })
            }
            onFocus={(p: RecentProduct) => setSpotlightId(p.id)}
            onWishlist={toggleWishlist}
          />
        </div>
      </main>

      <footer className="app__foot">
        <p>
          {still ? "Reduced motion is on. " : ""}
          Powered by <strong>AssemblyAI</strong> Voice Agent · Every action runs through
          the app&apos;s tool gateway — Echo only ever speaks what the server confirmed.
        </p>
      </footer>
    </div>
  );
}
