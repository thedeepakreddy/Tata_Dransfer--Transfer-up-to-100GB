import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { CallMode, CallState, CallQuality, ChatMessage, Role } from './useWebRTC';
import { v4 as uuidv4 } from 'uuid';
import { isValidCallMode } from './transferProtocol';

// An unanswered call stops ringing (on both sides) after this long.
const RING_TIMEOUT_MS = 45_000;

const VIDEO_CONSTRAINTS_HD = {
  width: { ideal: 1280, min: 640 },
  height: { ideal: 720, min: 480 },
  frameRate: { ideal: 30, min: 20 },
};

const VIDEO_CONSTRAINTS_FALLBACK = {
  width: { ideal: 854, min: 480 },
  height: { ideal: 480, min: 360 },
  frameRate: { ideal: 24, min: 15 },
};

const BITRATE_720P = 2_500_000;
const BITRATE_480P = 1_200_000;
const AUDIO_BITRATE = 64_000;

export function useCallManager(
  pcRef: React.MutableRefObject<RTCPeerConnection | null>,
  wsRef: React.MutableRefObject<WebSocket | null>,
  dcRef: React.MutableRefObject<RTCDataChannel | null>,
  userNameRef: React.MutableRefObject<string>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  roleRef: React.MutableRefObject<Role>,
  callState: CallState,
  setCallState: React.Dispatch<React.SetStateAction<CallState>>,
  callMode: CallMode,
  setCallMode: React.Dispatch<React.SetStateAction<CallMode>>,
  localStream: MediaStream | null,
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>,
  remoteStream: MediaStream | null,
  setRemoteStream: React.Dispatch<React.SetStateAction<MediaStream | null>>,
  callQuality: CallQuality | null,
  setCallQuality: React.Dispatch<React.SetStateAction<CallQuality | null>>,
  isScreenSharing: boolean,
  setIsScreenSharing: React.Dispatch<React.SetStateAction<boolean>>,
  isRecording: boolean,
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>
) {

  const localStreamRef = useRef<MediaStream | null>(null);
  // The stream from getUserMedia (camera and/or mic). It stays the source of
  // truth while screen sharing swaps what is shown/sent, so the microphone and
  // camera can always be found and stopped.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const isScreenSharingRef = useRef(false);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderRef = useRef<{ stop: () => Promise<Blob> } | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);
  const qualityMonitorHandleRef = useRef<NodeJS.Timeout | null>(null);
  const activeResolutionTierRef = useRef<'720p'|'480p'>('720p');
  const isCallerRef = useRef(false);
  const callStartTimeRef = useRef<number>(0);

  // Mirrors callState synchronously. React state lands a render later, which is
  // too late to reject a second copy of a signal that arrives in the same tick.
  const callStateRef = useRef<CallState>('idle');
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  const enterCallState = useCallback((next: CallState) => {
    callStateRef.current = next;
    setCallState(next);
    if (next !== 'ringing' && ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, [setCallState]);

  // Show 'ended' / 'rejected' briefly, then return to idle.
  const settleToIdle = useCallback((state: 'ended' | 'rejected') => {
    enterCallState(state);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      if (callStateRef.current === state) enterCallState('idle');
    }, 2000);
  }, [enterCallState]);

  // Keep the ref in step with state synchronously wherever a stream is set:
  // cleanup can run before React re-renders, and must find the live tracks.
  const setLocal = useCallback((stream: MediaStream | null) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, [setLocalStream]);

  const stopStream = (stream: MediaStream | null) => {
    stream?.getTracks().forEach(t => t.stop());
  };

  const sendCallSignal = useCallback((type: string, payload: any = {}) => {
    // Send over exactly one transport. Emitting on both the data channel and the
    // signaling socket delivers every signal twice, and the peer has no way to
    // tell the copies apart: a duplicated 'call-accept' opens a second camera
    // stream and renegotiates the connection on top of its own offer.
    if (dcRef.current?.readyState === 'open') {
      try {
        dcRef.current.send(JSON.stringify({ type, ...payload }));
        return true;
      } catch (e) {
        console.error('DC send error, falling back to signaling socket', e);
      }
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'call-signal', payload: { type, ...payload } }));
      return true;
    }
    console.warn('Cannot send call signal, no transport available:', type);
    return false;
  }, [dcRef, wsRef]);

  const startLocalMedia = useCallback(async (mode: CallMode) => {
    if (mode === 'audio') {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      return stream;
    } else {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: VIDEO_CONSTRAINTS_HD,
        });
        activeResolutionTierRef.current = '720p';
      } catch (err: any) {
        if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: VIDEO_CONSTRAINTS_FALLBACK,
          });
          activeResolutionTierRef.current = '480p';
        } else {
          throw err;
        }
      }
      return stream;
    }
  }, []);

  /**
   * Acquire camera/mic for the current call. If the call was ended or failed
   * while the permission prompt was open, the new stream is stopped at once
   * instead of being left running with no call to belong to.
   */
  const acquireMedia = useCallback(async (mode: CallMode) => {
    const stream = await startLocalMedia(mode);
    if (callStateRef.current !== 'connecting') {
      stopStream(stream);
      throw new Error('call-no-longer-active');
    }
    cameraStreamRef.current = stream;
    setLocal(stream);
    return stream;
  }, [startLocalMedia, setLocal]);

  const configureVideoSender = useCallback((sender: RTCRtpSender) => {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = activeResolutionTierRef.current === '720p' ? BITRATE_720P : BITRATE_480P;
    // @ts-ignore
    params.degradationPreference = 'maintain-resolution';
    sender.setParameters(params).catch(() => {});

    if (pcRef.current) {
      const transceiver = pcRef.current.getTransceivers().find(t => t.sender === sender);
      if (transceiver && transceiver.setCodecPreferences && window.RTCRtpSender?.getCapabilities) {
        const caps = RTCRtpSender.getCapabilities('video');
        if (caps) {
          const h264 = caps.codecs.filter(c => c.mimeType === 'video/H264');
          const others = caps.codecs.filter(c => c.mimeType !== 'video/H264');
          if (h264.length) transceiver.setCodecPreferences([...h264, ...others]);
        }
      }
    }
  }, [pcRef]);

  const configureAudioSender = useCallback((sender: RTCRtpSender) => {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = AUDIO_BITRATE;
    sender.setParameters(params).catch(() => {});
  }, []);

  const attachMediaToConnection = useCallback((stream: MediaStream) => {
    if (!pcRef.current) return;
    stream.getTracks().forEach(track => {
      const sender = pcRef.current!.addTrack(track, stream);
      if (track.kind === 'video') configureVideoSender(sender);
      if (track.kind === 'audio') configureAudioSender(sender);
    });
  }, [pcRef, configureVideoSender, configureAudioSender]);

  const getConnectionQuality = useCallback(async () => {
    if (!pcRef.current) return null;
    const stats = await pcRef.current.getStats();
    let candidatePair: any = null;
    let inboundVideo: any = null;

    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        candidatePair = report;
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundVideo = report;
      }
    });

    let pathLabel = 'Connecting…';
    if (candidatePair) {
      const localCandidate = stats.get(candidatePair.localCandidateId);
      pathLabel = localCandidate?.candidateType === 'host' ? 'Local WiFi ⚡' : 'Relayed 🌐';
    }

    let qualityTier = 'Low';
    if (inboundVideo) {
      const height = inboundVideo.frameHeight || 0;
      const lost = inboundVideo.packetsLost || 0;
      const received = inboundVideo.packetsReceived || 1;
      const lossRate = lost / (lost + received);

      if (height >= 720 && lossRate < 0.02) qualityTier = 'HD';
      else if (height >= 480 && lossRate < 0.05) qualityTier = 'Standard';
      else qualityTier = 'Low';
    } else {
      qualityTier = 'Voice';
    }

    return { qualityTier, pathLabel };
  }, [pcRef]);

  const stopQualityMonitor = useCallback(() => {
    if (qualityMonitorHandleRef.current) {
      clearInterval(qualityMonitorHandleRef.current);
      qualityMonitorHandleRef.current = null;
    }
  }, []);

  const startQualityMonitor = useCallback(() => {
    if (qualityMonitorHandleRef.current) return;
    qualityMonitorHandleRef.current = setInterval(async () => {
      const quality = await getConnectionQuality();
      if (quality) setCallQuality(quality);
    }, 2000);
  }, [getConnectionQuality, setCallQuality]);

  const saveRecording = useCallback((blob: Blob) => {
    if (!blob.size) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `call-recording-${Date.now()}.webm`;
    a.click();
    // Give the browser time to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  /** Stop an in-progress recording (if any) and save it to disk. */
  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    try {
      saveRecording(await rec.stop());
    } catch (e) {
      console.error('Stopping recording failed', e);
    }
    setIsRecording(false);
  }, [saveRecording, setIsRecording]);

  const cleanupCall = useCallback(() => {
    stopQualityMonitor();
    // A recording in progress is finished and saved rather than silently lost
    // (and its canvas loop and audio context are released).
    void stopRecording();
    setIsScreenSharing(false);
    isScreenSharingRef.current = false;
    setIsRecording(false);

    // Stop every track we ever started: the camera/mic stream, any screen
    // capture, and whatever is currently previewed.
    stopStream(cameraStreamRef.current);
    stopStream(screenStreamRef.current);
    stopStream(localStreamRef.current);
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setLocal(null);
    if (cameraTrackRef.current) {
      cameraTrackRef.current.stop();
      cameraTrackRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.getSenders().forEach(sender => {
        if (sender.track) pcRef.current!.removeTrack(sender);
      });
    }
    setRemoteStream(null);
    setCallQuality(null);
    setCallMode(null);
  }, [pcRef, stopQualityMonitor, stopRecording, setIsScreenSharing, setIsRecording, setLocal, setRemoteStream, setCallQuality, setCallMode]);

  // Use a ref for callMode since it's accessed in the callback
  const callModeRef = useRef<CallMode>(null);
  useEffect(() => { callModeRef.current = callMode; }, [callMode]);

  // Abandon a call that cannot start (most often a denied camera/mic prompt) and
  // say so in the thread, rather than leaving the caller ringing forever.
  const failCall = useCallback((text: string) => {
    cleanupCall();
    setMessages(prev => [...prev, {
      id: uuidv4(),
      senderRole: 'system',
      text,
      isSystemMessage: true,
      timestamp: Date.now(),
    }]);
    enterCallState('idle');
  }, [cleanupCall, setMessages, enterCallState]);

  const logCall = useCallback((reason: 'ended' | 'missed' | 'rejected' | 'unanswered' | 'lost') => {
    let text = '';
    const modeStr = callModeRef.current === 'video' ? 'Video call' : 'Voice call';
    if (reason === 'missed') {
      text = `Missed ${callModeRef.current === 'video' ? 'video' : 'voice'} call`;
    } else if (reason === 'unanswered') {
      text = `${modeStr} — no answer`;
    } else if (reason === 'lost') {
      text = `${modeStr} ended — connection lost`;
    } else if (reason === 'rejected') {
      text = `${modeStr} declined`;
    } else {
      if (callStartTimeRef.current > 0) {
        const durationSeconds = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
        const mins = Math.floor(durationSeconds / 60);
        const secs = durationSeconds % 60;
        const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        text = `${modeStr} ended (${durationStr})`;
      } else {
        text = `${modeStr} ended`;
      }
    }
    
    setMessages(prev => [...prev, {
      id: uuidv4(),
      senderRole: 'system',
      text,
      isSystemMessage: true,
      timestamp: Date.now()
    }]);
    callStartTimeRef.current = 0;
  }, [setMessages]);

  const handleCallMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'call-request':
        // Already busy: ignore rather than stacking a second incoming call.
        if (callStateRef.current !== 'idle') return;
        if (!isValidCallMode(msg.mode)) return;
        setCallMode(msg.mode);
        callModeRef.current = msg.mode;
        isCallerRef.current = false;
        enterCallState('incoming');
        break;

      case 'call-accept': {
        // Only the caller acts on an accept, and only while still ringing.
        if (!isCallerRef.current || callStateRef.current !== 'ringing') return;
        enterCallState('connecting');
        acquireMedia(callModeRef.current)
          .then(async (stream) => {
            if (!pcRef.current) throw new Error('no-peer-connection');
            attachMediaToConnection(stream);
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            sendCallSignal('call-offer', { sdp: offer });
          })
          .catch((err) => {
            if (err?.message === 'call-no-longer-active') return; // ended meanwhile
            console.error('Could not start the call', err);
            sendCallSignal('call-end');
            failCall(err?.message === 'no-peer-connection'
              ? 'Call failed — not connected to the other device.'
              : 'Call failed — camera or microphone unavailable.');
          });
        break;
      }

      case 'call-offer':
        // Media renegotiation is only legitimate while a call is being set up
        // or is running; never let it add tracks to an idle session.
        if (!pcRef.current || (callStateRef.current !== 'connecting' && callStateRef.current !== 'active')) return;
        if (!msg.sdp || typeof msg.sdp !== 'object') return;
        pcRef.current
          .setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(async () => {
            const answer = await pcRef.current!.createAnswer();
            await pcRef.current!.setLocalDescription(answer);
            sendCallSignal('call-answer', { sdp: answer });
          })
          .catch((err) => console.error('Call renegotiation failed', err));
        break;

      case 'call-answer':
        // Only meaningful while our own offer is outstanding.
        if (!pcRef.current || pcRef.current.signalingState !== 'have-local-offer') return;
        if (!msg.sdp || typeof msg.sdp !== 'object') return;
        pcRef.current
          .setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .catch((err) => console.error('Could not apply call answer', err));
        break;

      case 'call-reject':
        if (callStateRef.current === 'idle' || callStateRef.current === 'ended' || callStateRef.current === 'rejected') return;
        logCall('rejected');
        cleanupCall();
        settleToIdle('rejected');
        break;

      case 'call-end': {
        const state = callStateRef.current;
        if (state === 'idle' || state === 'ended' || state === 'rejected') return;
        // The caller gave up before we answered: that is a missed call.
        logCall(state === 'incoming' ? 'missed' : 'ended');
        cleanupCall();
        settleToIdle('ended');
        break;
      }
    }
  }, [acquireMedia, attachMediaToConnection, cleanupCall, failCall, logCall, pcRef, setCallMode, enterCallState, settleToIdle, sendCallSignal]);

  const startCall = useCallback((mode: CallMode) => {
    if (callStateRef.current !== 'idle') return;
    if (!isValidCallMode(mode)) return;
    setCallMode(mode);
    callModeRef.current = mode;
    isCallerRef.current = true;
    if (!sendCallSignal('call-request', { mode })) {
      failCall('Could not start the call — no connection to the other device.');
      return;
    }
    enterCallState('ringing');
    // Do not ring forever if the other side never answers.
    ringTimerRef.current = setTimeout(() => {
      ringTimerRef.current = null;
      if (callStateRef.current !== 'ringing') return;
      sendCallSignal('call-end');
      logCall('unanswered');
      cleanupCall();
      settleToIdle('ended');
    }, RING_TIMEOUT_MS);
  }, [sendCallSignal, setCallMode, enterCallState, failCall, logCall, cleanupCall, settleToIdle]);

  const acceptCall = useCallback(async () => {
    if (callStateRef.current !== 'incoming') return;
    enterCallState('connecting');
    try {
      const stream = await acquireMedia(callModeRef.current);
      attachMediaToConnection(stream);
      sendCallSignal('call-accept');
    } catch (err: any) {
      if (err?.message === 'call-no-longer-active') return; // caller hung up meanwhile
      // Most often the user denied the camera/microphone prompt.
      console.error('Could not start local media for call', err);
      sendCallSignal('call-reject');
      failCall('Call declined — camera or microphone unavailable.');
    }
  }, [acquireMedia, attachMediaToConnection, sendCallSignal, enterCallState, failCall]);

  const rejectCall = useCallback(() => {
    if (callStateRef.current === 'idle') return;
    logCall('rejected');
    sendCallSignal('call-reject');
    setCallMode(null);
    enterCallState('idle');
  }, [sendCallSignal, setCallMode, enterCallState, logCall]);

  const endCall = useCallback(() => {
    const state = callStateRef.current;
    if (state === 'idle' || state === 'ended' || state === 'rejected') return;
    logCall(state === 'ringing' ? 'unanswered' : 'ended');
    sendCallSignal('call-end');
    cleanupCall();
    settleToIdle('ended');
  }, [sendCallSignal, cleanupCall, settleToIdle, logCall]);

  /**
   * The peer connection or data channel is gone. Media cannot keep flowing, so
   * end any call locally and release the camera and microphone.
   */
  const handleConnectionLost = useCallback(() => {
    const state = callStateRef.current;
    if (state === 'idle' || state === 'ended' || state === 'rejected') return;
    logCall(state === 'incoming' ? 'missed' : 'lost');
    cleanupCall();
    settleToIdle('ended');
  }, [cleanupCall, settleToIdle, logCall]);

  // Unmount: no timer may fire into a torn-down component.
  useEffect(() => () => {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return false;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = !audioTrack.enabled;
    return audioTrack ? !audioTrack.enabled : false;
  }, []);

  const toggleCamera = useCallback(() => {
    if (!localStreamRef.current) return false;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (videoTrack) videoTrack.enabled = !videoTrack.enabled;
    return videoTrack ? !videoTrack.enabled : false;
  }, []);

  const stopScreenShare = useCallback(async () => {
    // Read from a ref: this also runs from the screen track's 'ended' event
    // (the browser's own "Stop sharing" button), where a captured state value
    // would be stale and make the call a no-op.
    if (!isScreenSharingRef.current) return;
    isScreenSharingRef.current = false;
    const screenStream = screenStreamRef.current;
    screenStreamRef.current = null;
    const screenTrack = screenStream?.getVideoTracks()[0] ?? null;
    try {
      const videoSender = pcRef.current?.getSenders().find(s => s.track === screenTrack) ??
        pcRef.current?.getSenders().find(s => s.track && s.track.kind === 'video');
      if (videoSender && cameraTrackRef.current) {
        await videoSender.replaceTrack(cameraTrackRef.current);
      }
    } catch (e) {
      console.error('Restoring camera after screen share failed', e);
    }
    stopStream(screenStream);
    cameraTrackRef.current = null;
    setIsScreenSharing(false);
    // Preview the camera/mic stream again (not the dead screen capture).
    if (cameraStreamRef.current) setLocal(cameraStreamRef.current);
  }, [pcRef, setIsScreenSharing, setLocal]);

  const startScreenShare = useCallback(async () => {
    if (!pcRef.current || isScreenSharingRef.current) return;
    const videoSender = pcRef.current.getSenders().find(s => s.track && s.track.kind === 'video');
    // Screen sharing replaces the outgoing camera track; an audio-only call has
    // none. Bail out before prompting so no capture is left running unused.
    if (!videoSender) {
      setMessages(prev => [...prev, {
        id: uuidv4(),
        senderRole: 'system',
        text: 'Screen sharing is available in video calls.',
        isSystemMessage: true,
        timestamp: Date.now(),
      }]);
      return;
    }
    let screenStream: MediaStream | null = null;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];
      // The call may have ended while the picker was open.
      if (callStateRef.current !== 'active' && callStateRef.current !== 'connecting') {
        stopStream(screenStream);
        return;
      }

      cameraTrackRef.current = videoSender.track;
      await videoSender.replaceTrack(screenTrack);
      screenTrack.contentHint = 'detail';

      screenStreamRef.current = screenStream;
      isScreenSharingRef.current = true;
      setIsScreenSharing(true);
      // Preview the screen, but keep the microphone track in the local stream
      // so mute keeps working while sharing.
      const audio = cameraStreamRef.current?.getAudioTracks() ?? [];
      setLocal(new MediaStream([screenTrack, ...audio]));

      screenTrack.onended = () => { void stopScreenShare(); };
    } catch (e) {
      console.error('Screen share error', e);
      if (!isScreenSharingRef.current) stopStream(screenStream);
    }
  }, [pcRef, setIsScreenSharing, setLocal, setMessages, stopScreenShare]);

  const attachTrackHandler = useCallback(() => {
    if (!pcRef.current) return;
    pcRef.current.ontrack = (event) => {
      // Tracks only matter while a call is being set up or running. A late
      // track after hang-up must not resurrect the call UI.
      const state = callStateRef.current;
      if (state !== 'connecting' && state !== 'active') return;
      setRemoteStream(prev => {
        const newStream = new MediaStream();
        if (prev) {
          prev.getTracks().forEach(t => newStream.addTrack(t));
        }
        const incomingTracks = event.streams && event.streams[0] ? event.streams[0].getTracks() : [event.track];
        incomingTracks.forEach(t => {
          if (!newStream.getTracks().find(nt => nt.id === t.id)) {
            newStream.addTrack(t);
          }
        });
        return newStream;
      });
        if (callStartTimeRef.current === 0) {
          callStartTimeRef.current = Date.now();
        }
        enterCallState('active');
        startQualityMonitor();
    };
  }, [pcRef, setRemoteStream, enterCallState, startQualityMonitor]);

  const startRecording = useCallback(({ localVideoEl, remoteVideoEl }: { localVideoEl: HTMLVideoElement | null, remoteVideoEl: HTMLVideoElement | null }) => {
    if (recorderRef.current) return recorderRef.current;
    if (typeof MediaRecorder === 'undefined') {
      setMessages(prev => [...prev, {
        id: uuidv4(), senderRole: 'system', text: 'Recording is not supported in this browser.',
        isSystemMessage: true, timestamp: Date.now(),
      }]);
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let drawing = true;
    function drawFrame() {
      if (!drawing) return;
      if (ctx) {
        ctx.fillStyle = '#14181C';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (remoteVideoEl && remoteVideoEl.readyState >= 2) {
          ctx.drawImage(remoteVideoEl, 0, 0, canvas.width, canvas.height);
        }
        if (localVideoEl && localVideoEl.readyState >= 2) {
          const pipW = 240, pipH = 135;
          ctx.drawImage(localVideoEl, canvas.width - pipW - 16, canvas.height - pipH - 16, pipW, pipH);
        }
      }
      requestAnimationFrame(drawFrame);
    }
    drawFrame();

    // @ts-ignore
    const canvasStream = canvas.captureStream(30);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    
    if (localStreamRef.current?.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(localStreamRef.current.getAudioTracks())).connect(dest);
    }
    const remote = remoteStreamRef.current;
    if (remote?.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(remote.getAudioTracks())).connect(dest);
    }

    const mixedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const releaseAll = () => {
      drawing = false;
      canvasStream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      audioCtx.close().catch(() => {});
    };

    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;
    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
      recorder = new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 2_000_000 });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(1000);
    } catch (e) {
      console.error('Could not start recording', e);
      releaseAll();
      setMessages(prev => [...prev, {
        id: uuidv4(), senderRole: 'system', text: 'Recording could not be started in this browser.',
        isSystemMessage: true, timestamp: Date.now(),
      }]);
      return null;
    }

    setIsRecording(true);

    const handle = {
      stop: () => new Promise<Blob>((resolve) => {
        const finish = () => {
          releaseAll();
          setIsRecording(false);
          resolve(new Blob(chunks, { type: 'video/webm' }));
        };
        if (recorder.state === 'inactive') return finish();
        recorder.onstop = finish;
        try { recorder.stop(); } catch { finish(); }
      }),
    };
    recorderRef.current = handle;
    return handle;
  }, [setIsRecording, setMessages]);

  const packageRecordingForChat = useCallback((blob: Blob) => {
    const filename = `call-recording-${Date.now()}.webm`;
    return {
      type: 'local-recording',
      filename,
      blob,
      objectUrl: URL.createObjectURL(blob),
      sizeBytes: blob.size,
      timestamp: Date.now(),
    };
  }, []);

  return {
    handleCallMessage,
    attachTrackHandler,
    cleanupCall,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    startRecording,
    stopRecording,
    packageRecordingForChat,
    handleConnectionLost,
  };
}
