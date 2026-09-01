import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ALOO — Webcam capture + frame extraction for the vision pipeline.
 * ===========================================================================
 * Owns three things:
 *   1. The MediaStream lifecycle (and its guaranteed teardown — an un-stopped
 *      track leaves the camera light on, which users rightly find alarming).
 *   2. A hidden <canvas> used to rasterise the current video frame into a
 *      base64 JPEG, which is the wire format both Gemini and the NIM VLMs take.
 *   3. A capture interval that keeps `latestFrame` fresh, so a prompt sent at
 *      any moment can attach what ALOO is "seeing" right now.
 *
 * Frames are downscaled to `maxWidth` before encoding. This matters a lot:
 * a 1280x720 JPEG is ~4x the tokens of a 640x360 one for no accuracy gain on
 * scene-level questions.
 */
export default function useWebcam({ enabled, captureIntervalMs = 2500, quality = 0.7, maxWidth = 640 }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const latestFrameRef = useRef(null); // read synchronously when sending a prompt

  const [active, setActive] = useState(false);
  const [error, setError] = useState(null);
  const [frameCount, setFrameCount] = useState(0);
  const [devices, setDevices] = useState([]);
  const [resolution, setResolution] = useState(null);

  /* -- Capture one frame --------------------------------------------------- */
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvasRef.current = canvas;
    }

    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // JPEG (not PNG): photographic frames compress ~10x better, and both
    // vision APIs accept image/jpeg.
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    latestFrameRef.current = { dataUrl, at: Date.now(), w: canvas.width, h: canvas.height };
    return dataUrl;
  }, [maxWidth, quality]);

  /* -- Stream lifecycle ---------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      latestFrameRef.current = null;
      setActive(false);
      setResolution(null);
    };

    if (!enabled) {
      stop();
      return undefined;
    }

    (async () => {
      try {
        setError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Some browsers reject play() if the element is not yet in the DOM.
          await videoRef.current.play().catch(() => {});
          setResolution({
            w: videoRef.current.videoWidth,
            h: videoRef.current.videoHeight,
          });
        }
        setActive(true);

        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) setDevices(list.filter((d) => d.kind === 'videoinput'));
        } catch {
          /* labels need permission; not fatal */
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err.name === 'NotAllowedError'
              ? 'Camera permission denied. Enable it in your browser site settings.'
              : `Camera unavailable: ${err.message}`
          );
          setActive(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled]);

  /* -- Periodic capture ----------------------------------------------------- */
  useEffect(() => {
    if (!enabled || !active) return undefined;
    const id = setInterval(() => {
      if (captureFrame()) setFrameCount((n) => n + 1);
    }, Math.max(500, captureIntervalMs));
    // Grab one immediately so the first prompt after enabling has an image.
    captureFrame();
    setFrameCount((n) => n + 1);
    return () => clearInterval(id);
  }, [enabled, active, captureIntervalMs, captureFrame]);

  /** Newest frame as a data URL, or null. Safe to call during a send. */
  const getLatestFrame = useCallback(() => {
    // Re-capture if the cached frame is stale — a 10s-old image is worse than
    // none when the user asks "what am I holding?".
    const cached = latestFrameRef.current;
    if (!cached || Date.now() - cached.at > captureIntervalMs * 1.5) {
      const fresh = captureFrame();
      if (fresh) return fresh;
    }
    return cached?.dataUrl || null;
  }, [captureFrame, captureIntervalMs]);

  return {
    videoRef,
    active,
    error,
    devices,
    resolution,
    frameCount,
    captureFrame,
    getLatestFrame,
  };
}
