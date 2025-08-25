import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import { color } from 'three/tsl';

// --- Game Settings (Constants) ---
const WORM_INITIAL_LENGTH = 10;
const WORM_BASE_SEGMENT_RADIUS = 5.5; // Slightly larger base radius
const WORM_RADIUS_GROWTH_FACTOR = 0.04; // Slightly slower growth
const WORM_MAX_SEGMENT_RADIUS = 16;
const FOOD_RADIUS = 7; // Default fallback radius for glowing orbs
const WORLD_WIDTH = 700;
const WORLD_HEIGHT = 700;
const WORM_WIGGLE_SPEED = 0.3;
const WORM_WIGGLE_MAGNITUDE = 0.5;
const WORM_BLINK_INTERVAL = 3000;
const JOYSTICK_SEND_INTERVAL = 50;
const JOYSTICK_SIZE = 130; // Slightly larger joystick base
const STICK_SIZE = 50;  // Slightly larger stick
const JOYSTICK_DEADZONE = 0.1;
const BACKGROUND_GRID_SIZE = 60; // Size of background grid squares - No longer used for drawing grid

// IMPORTANT: Replace with your actual server URL if different
const SERVER_URL = 'https://server-975113276602.asia-south1.run.app';

// Assuming you have food images named 1.png, 2.png, ..., 36.png in a 'public/food' directory
const FOOD_IMAGE_TYPES = 36;

// --- Special Food Types (Matching image filenames) ---
const FOOD_TYPE_POWER = 15; // Corresponds to 15.png for speed boost
const FOOD_TYPE_ZOOM = 12; // Corresponds to 12.png for zoom out
const FOOD_TYPE_MAGNET = 7; // Corresponds to 7.png for magnet effect

// --- Power Up Settings ---
const POWER_UP_DURATION = 10000; // 10 seconds in milliseconds
const SPEED_BOOST_FACTOR = 1.5; // 50% speed increase
const ZOOM_OUT_FACTOR = 0.7; // TEMPORARILY MORE AGGRESSIVE ZOOM for testing (was 0.7)
const MAGNET_RADIUS_MULTIPLIER = 3; // Magnet picks up food from 3x the normal distance


// --- Connection Status Enum ---
const ConnectionStatus = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed',
    DISCONNECTED: 'disconnected',
    RECONNECTING: 'reconnecting',
};

// --- Helper: HSL Color Manipulation ---
// Helper to adjust lightness of an HSL color string
function adjustHSL(hslColor, lightnessAdjustment) {
    if (typeof hslColor !== 'string' || !hslColor.startsWith('hsl')) return hslColor;
    try {
        const parts = hslColor.match(/hsl\((\d+(\.\d+)?)\s*,\s*(\d+)%\s*,\s*(\d+)%\)/);
        if (!parts) return hslColor;
        const h = parseFloat(parts[1]);
        const s = parseInt(parts[3]);
        let l = parseInt(parts[4]);
        l = Math.max(0, Math.min(100, l + lightnessAdjustment)); // Adjust and clamp lightness
        return `hsl(${h}, ${s}%, ${l}%)`;
    } catch (e) {
        return hslColor; // Return original on error
    }
}


// --- Worm Class ---
class Worm {
    constructor(id, segments, color, angle = 0) {
        this.id = id;
        this.segments = segments || [];
        this.angle = angle;
        // Ensure color is a string, fallback to random HSL if not provided or invalid type
        this.color = (typeof color === 'string' && color.startsWith('hsl'))
                     ? color
                     : `hsl(${Math.random() * 360}, 80%, 60%)`;
        this.eyeColor = 'white';
        this.pupilColor = 'black';
        this.lastBlinkTime = Date.now();
        this.isBlinking = false;
        // Store derived colors for performance
        this.primaryColor = this.color;
        this.shadowColor = adjustHSL(this.color, -20); // Darker shade
        this.highlightColor = adjustHSL(this.color, 15); // Lighter shade
        this.speedBoostEndTime = 0; // Timestamp when speed boost ends
    }

    // Update color and derived shades
    updateColor(newColor) {
         if (typeof newColor === 'string' && newColor.startsWith('hsl') && newColor !== this.color) {
             this.color = newColor;
             this.primaryColor = this.color;
             this.shadowColor = adjustHSL(this.color, -20);
             this.highlightColor = adjustHSL(this.color, 15);
         }
    }

    applySpeedBoost() {
        this.speedBoostEndTime = Date.now() + POWER_UP_DURATION;
    }

    isSpeedBoostActive() {
        return Date.now() < this.speedBoostEndTime;
    }


    getCurrentRadius() {
        const length = this.segments?.length || WORM_INITIAL_LENGTH;
        const calculatedRadius = WORM_BASE_SEGMENT_RADIUS + (length * WORM_RADIUS_GROWTH_FACTOR);
        return Math.min(calculatedRadius, WORM_MAX_SEGMENT_RADIUS);
    }

    /**
     * Draws the worm on the canvas context with a more 3D-like style, closer to the image.
     * @param {CanvasRenderingContext2D} ctx - The drawing context.
     * @param {boolean} isPlayerControlled - Flag if this worm is the player.
     * @param {number} lookAngle - The angle the pupils should look towards.
     * @param {number} time - Current time in seconds for animations.
     */
        /**
     * Draws the worm on the canvas context with a more 3D-like style, closer to the image.
     * @param {CanvasRenderingContext2D} ctx - The drawing context.
     * @param {boolean} isPlayerControlled - Flag if this worm is the player.
     * @param {number} lookAngle - The angle the pupils should look towards.
     * @param {number} time - Current time in seconds for animations.
     * @param {number} currentZoomFactor - The current zoom factor to apply manually.
     */
    // Added currentZoomFactor parameter
    draw(ctx, isPlayerControlled = false, lookAngle, time, currentZoomFactor) {
        if (!this.segments || this.segments.length === 0) return;

        const currentSegmentRadius = this.getCurrentRadius();
        const currentHeadRadius = currentSegmentRadius + 3; // Head slightly larger than in previous version, closer to image
        const now = Date.now();

        // Use pre-calculated colors stored in the instance
        const primaryColor = this.primaryColor;
        const shadowColor = adjustHSL(this.color, -20); // Darker shade
        const highlightColor = adjustHSL(this.color, 15); // Lighter shade

        // Blinking logic
        if (now - this.lastBlinkTime > WORM_BLINK_INTERVAL + Math.random() * 500 - 250) {
            this.isBlinking = true;
            setTimeout(() => { this.isBlinking = false; }, 150);
            this.lastBlinkTime = now;
        }

        // --- Draw Segments (Tail to Head) ---
        for (let i = this.segments.length - 1; i > 0; i--) {
            const seg = this.segments[i];
            if (!seg) continue;
            const prevSeg = this.segments[i - 1] || seg;
            const dx = seg.x - prevSeg.x;
            const dy = seg.y - prevSeg.y;
            const segAngle = Math.atan2(dy, dx);
            const wiggleOffsetAngle = segAngle + Math.PI / 2;
            const wiggle = Math.sin(time * WORM_WIGGLE_SPEED + i * 0.5) * WORM_WIGGLE_MAGNITUDE * (currentSegmentRadius / WORM_BASE_SEGMENT_RADIUS);
            // Manually scale segment position and radius
            const scaledDrawX = (seg.x + Math.cos(wiggleOffsetAngle) * wiggle) * currentZoomFactor;
            const scaledDrawY = (seg.y + Math.sin(wiggleOffsetAngle) * wiggle) * currentZoomFactor;
            const scaledSegmentRadius = currentSegmentRadius * currentZoomFactor;


            // --- Wormszone Style Gradient for Segments ---
            // Use scaled coordinates and radius for the gradient
            const gradient = ctx.createRadialGradient(
                scaledDrawX - scaledSegmentRadius * 0.3,
                scaledDrawY - scaledSegmentRadius * 0.3,
                scaledSegmentRadius * 0.1,
                scaledDrawX,
                scaledDrawY,
                scaledSegmentRadius
            );
            gradient.addColorStop(0, highlightColor);
            gradient.addColorStop(0.5, primaryColor);
            gradient.addColorStop(1, shadowColor);

            // Draw segment
            ctx.beginPath();
            // Use scaled position and radius for the arc
            ctx.arc(scaledDrawX, scaledDrawY, scaledSegmentRadius, 0, Math.PI * 2);
            ctx.fillStyle = gradient;
            ctx.shadowColor = 'rgba(207, 235, 231, 0.17)';
            ctx.shadowBlur = 4 * currentZoomFactor; // Scale shadow blur
            ctx.shadowOffsetY = 2 * currentZoomFactor; // Scale shadow offset
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Add a subtle dark stroke between segments for definition, similar to the image
            if (i > 0) {
                 const nextSeg = this.segments[i - 1];
                 if (nextSeg) {
                    // Use scaled positions for the line
                    const scaledNextSegX = nextSeg.x * currentZoomFactor;
                    const scaledNextSegY = nextSeg.y * currentZoomFactor;
                    const segmentDistance = Math.sqrt(dx*dx + dy*dy);
                    // Only draw stroke if segments are reasonably close (consider scaled distance?)
                    // For simplicity, keeping the world coordinate check for now.
                    if (segmentDistance < currentSegmentRadius * 3) {
                         ctx.strokeStyle = 'rgba(0, 0, 0, 0.05)'; // Darker stroke
                         ctx.lineWidth = 1.5 * currentZoomFactor; // Scale line width
                         ctx.beginPath();
                         ctx.moveTo(scaledDrawX, scaledDrawY);
                         ctx.lineTo(scaledNextSegX, scaledNextSegY); // Draw line to the center of the next segment
                         ctx.stroke();
                    }
                 }
            }
        }

        // --- Draw Head ---
        const head = this.segments[0];
        if (!head) return;

        // Manually scale head position and radius
        const scaledHeadX = head.x * currentZoomFactor;
        const scaledHeadY = head.y * currentZoomFactor;
        const scaledHeadRadius = currentHeadRadius * currentZoomFactor * 1/1.05;


        // Head Gradient
        // Use scaled coordinates and radius for the gradient
        const headGradient = ctx.createRadialGradient(
            scaledHeadX - scaledHeadRadius * 0.3,
            scaledHeadY - scaledHeadRadius * 4,
            scaledHeadRadius * 0.1,
            scaledHeadX,
            scaledHeadY,
            scaledHeadRadius
        );
        headGradient.addColorStop(0, highlightColor);
        headGradient.addColorStop(0.5, primaryColor);
        headGradient.addColorStop(1, shadowColor);

        // Draw head circle
        ctx.beginPath();
        // Use scaled position and radius for the arc
        ctx.arc(scaledHeadX, scaledHeadY, scaledHeadRadius, 0, Math.PI * 2);
        ctx.fillStyle = headGradient;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 5 * currentZoomFactor; // Scale shadow blur
        ctx.shadowOffsetY = 3 * currentZoomFactor; // Scale shadow offset
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        // --- Draw Eyes (Closer to Wormszone styl) ---
        const eyeAngleOffset = Math.PI / 5; // Slightly closer together than previous
        const eyeDist = currentHeadRadius * 0.7; // Closer to head center
        const eyeSize = currentHeadRadius * 0.3; // Slightly smaller eyes
        const pupilSize = eyeSize * 0.6; // Slightly larger pupils

        // Calculate eye positions relative to scaled head, then apply scaled head position
        const scaledEyeDist = eyeDist * currentZoomFactor;
        const scaledEyeSize = eyeSize * currentZoomFactor;
        const scaledPupilSize = pupilSize * currentZoomFactor;

        const eye1X = scaledHeadX + Math.cos(this.angle - eyeAngleOffset) * scaledEyeDist;
        const eye1Y = scaledHeadY + Math.sin(this.angle - eyeAngleOffset) * scaledEyeDist;
        const eye2X = scaledHeadX + Math.cos(this.angle + eyeAngleOffset) * scaledEyeDist;
        const eye2Y = scaledHeadY + Math.sin(this.angle + eyeAngleOffset) * scaledEyeDist;


        if (this.isBlinking) {
            // Draw closed eyes (curved lines)
            ctx.strokeStyle = this.pupilColor;
            ctx.lineWidth = 2 * currentZoomFactor; // Scale line width
            ctx.beginPath();
            // Use scaled position and radius for the arc
            ctx.arc(eye1X, eye1Y, scaledEyeSize * 0.8, Math.PI * 0.1, Math.PI * 0.9); // Upper curve
            ctx.stroke();
            ctx.beginPath();
            // Use scaled position and radius for the arc
            ctx.arc(eye2X, eye2Y, scaledEyeSize * 0.8, Math.PI * 0.1, Math.PI * 0.9); // Upper curve
            ctx.stroke();
        } else {
            // Draw open eyes
            // Eyeballs (white part)
            ctx.fillStyle = this.eyeColor;
            ctx.shadowColor = 'rgba(0, 0, 0, 0.1)'; // Slight shadow for eyes
            ctx.shadowBlur = 3 * currentZoomFactor; // Scale shadow blur
            ctx.shadowOffsetY = 1 * currentZoomFactor; // Scale shadow offset
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(eye1X, eye1Y, scaledEyeSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(eye2X, eye2Y, scaledEyeSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowColor = 'transparent'; // Reset shadow
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Pupils (black part) - looking towards target angle
            const pupilTargetAngle = isPlayerControlled ? lookAngle : this.angle;
            const pupilDist = eyeSize * 0.25; // Pupil movement range
            const scaledPupilDist = pupilDist * currentZoomFactor;

            // Calculate pupil positions relative to scaled eye, then apply scaled eye position
            const pupil1X = eye1X + Math.cos(pupilTargetAngle) * scaledPupilDist;
            const pupil1Y = eye1Y + Math.sin(pupilTargetAngle) * scaledPupilDist;
            const pupil2X = eye2X + Math.cos(pupilTargetAngle) * scaledPupilDist;
            const pupil2Y = eye2Y + Math.sin(pupilTargetAngle) * scaledPupilDist;

            // Draw pupils
            ctx.fillStyle = this.pupilColor;
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(pupil1X, pupil1Y, scaledPupilSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(pupil2X, pupil2Y, scaledPupilSize, 0, Math.PI * 2);
            ctx.fill();

             // Add small highlight reflection to pupils
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(pupil1X + scaledPupilSize * 0.3, pupil1Y - scaledPupilSize * 0.3, scaledPupilSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            // Use scaled position and size for the arc
            ctx.arc(pupil2X + scaledPupilSize * 0.3, pupil2Y - scaledPupilSize * 0.3, scaledPupilSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

}


// --- Custom Virtual Joystick Component ---
// Update default colors for a more wormszone-like transparent style
const VirtualJoystick = ({
    size = JOYSTICK_SIZE,
    stickSize = STICK_SIZE,
    // Wormszone style: Semi-transparent grey base, brighter stick
    baseColor = 'rgba(100, 100, 120, 0.1)', // Darker semi-transparent base
    stickColor = 'rgba(255, 255, 255, 0.4)', // Brighter semi-transparent stick
    onMove,
    onStop,
    initialPosition
}) => {
    const baseRef = useRef(null);
    const [isDragging, setIsDragging] = useState(false);
    const [stickPos, setStickPos] = useState({ x: 0, y: 0 });
    const joystickCenter = useRef({ x: 0, y: 0 });
    const maxDist = size / 2;

    useEffect(() => {
        if (initialPosition) {
            joystickCenter.current = { x: initialPosition.x, y: initialPosition.y };
            setIsDragging(true);
        }
    }, [initialPosition]);

    const handleInteractionMove = useCallback((clientX, clientY) => {
        if (!isDragging || !joystickCenter.current) return;
        const baseX = joystickCenter.current.x;
        const baseY = joystickCenter.current.y;
        let deltaX = clientX - baseX;
        let deltaY = clientY - baseY;
        const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        let angleRad = Math.atan2(deltaY, deltaX);
        const clampedDist = Math.min(dist, maxDist);
        const stickX = Math.cos(angleRad) * clampedDist;
        const stickY = Math.sin(angleRad) * clampedDist;
        setStickPos({ x: stickX, y: stickY });
        const normalizedDist = clampedDist / maxDist;
        if (normalizedDist > JOYSTICK_DEADZONE) {
            if (onMove) onMove({ angle: angleRad, distance: normalizedDist, x: stickX / maxDist, y: stickY / maxDist });
        } else {
            setStickPos({ x: 0, y: 0 });
            if (onStop) onStop();
        }
    }, [isDragging, maxDist, onMove, onStop]);

    const handleInteractionEnd = useCallback(() => {
        if (!isDragging) return;
        setIsDragging(false);
        setStickPos({ x: 0, y: 0 });
        if (onStop) onStop();
    }, [isDragging, onStop]);

    useEffect(() => {
        const moveHandler = (e) => {
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            handleInteractionMove(clientX, clientY);
        };
        const endHandler = () => handleInteractionEnd();
        if (isDragging) {
            window.addEventListener('mousemove', moveHandler);
            window.addEventListener('touchmove', moveHandler, { passive: false });
            window.addEventListener('mouseup', endHandler);
            window.addEventListener('touchend', endHandler);
            window.addEventListener('touchcancel', endHandler);
        }
        return () => {
            window.removeEventListener('mousemove', moveHandler);
            window.removeEventListener('touchmove', moveHandler);
            window.removeEventListener('mouseup', endHandler);
            window.removeEventListener('touchend', endHandler);
            window.removeEventListener('touchcancel', endHandler);
        };
    }, [isDragging, handleInteractionMove, handleInteractionEnd]);

    if (!initialPosition) return null;

    return (
        <div
            ref={baseRef}
            style={{
                position: 'absolute',
                left: `${initialPosition.x}px`,
                top: `${initialPosition.y}px`,
                transform: 'translate(-50%, -50%)',
                width: `${size}px`,
                height: `${size}px`,
                borderRadius: '50%',
                // Updated base style: Thicker border, slightly darker background
                border: `1px solid ${baseColor}`, // Thicker border
                backgroundColor: 'rgba(50, 50, 60, 0.1)', // Very subtle dark fill
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                pointerEvents: 'none',
                zIndex: 50,
            }}
        >
            <div
                style={{
                    width: `${stickSize}px`,
                    height: `${stickSize}px`,
                    borderRadius: '50%',
                    // Updated stick style: Brighter, maybe slight gradient/shadow
                    backgroundColor: stickColor,
                    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)', // Subtle shadow on stick
                    position: 'absolute',
                    left: `calc(50% + ${stickPos.x}px)`,
                    top: `calc(50% + ${stickPos.y}px)`,
                    transform: 'translate(-50%, -50%)',
                    pointerEvents: 'none',
                }}
            />
        </div>
    );
};


// --- Main React App Component ---
function App() {
    // --- Refs ---
    const canvasRef = useRef(null);
    const socketRef = useRef(null);
    const playerWormRef = useRef(null);
    const otherWormsRef = useRef(new Map());
    const foodRef = useRef([]);
    const cameraOffsetRef = useRef({ x: 0, y: 0 }); // Still used for minimap
    const animationFrameIdRef = useRef(null);
    const worldSizeRef = useRef({ width: WORLD_WIDTH, height: WORLD_HEIGHT });
    const connectionAttemptTimer = useRef(null);
    const scoreRef = useRef(0);
    const leaderboardRef = useRef([]);
    const playerIdRef = useRef(null);
    const lastFrameTimeRef = useRef(performance.now());
    const joystickAngleRef = useRef(null);
    const lastJoystickSendTimeRef = useRef(0);
    const interactionActive = useRef(false);
    const foodImagesRef = useRef({});
    const backgroundRef = useRef(`hsl(${Math.random() * 360}, 80%, 60%)`);
    // Ref for background pattern canvas - No longer needed for grid, but keeping for potential future use
    const backgroundPatternCanvasRef = useRef(null);
    // Flag to track if initial camera position has been set
    const initialCameraSetRef = useRef(false);


    // --- Power Up State/Refs ---
    const [isZoomActive, setIsZoomActive] = useState(false);
    const isZoomActiveRef = useRef(isZoomActive);
    const zoomEndTimeRef = useRef(0);
    const isMagnetActiveRef = useRef(false); // Using ref for magnet as it affects game logic directly


    // --- State ---
    const [score, setScore] = useState(0);
    const [leaderboard, setLeaderboard] = useState([]);
    const [isGameOver, setIsGameOver] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState(ConnectionStatus.IDLE);
    const [connectionErrorMsg, setConnectionErrorMsg] = useState('');
    const [playerId, setPlayerId] = useState(null);
    const [canvasSize, setCanvasSize] = useState({ width: window.innerWidth, height: window.innerHeight });
    const connectionStatusRef = useRef(connectionStatus);
    const [showJoystick, setShowJoystick] = useState(false);
    const [joystickPosition, setJoystickPosition] = useState({ x: 0, y: 0 });

    // --- Update Refs when State Changes ---
    useEffect(() => { scoreRef.current = score; }, [score]);
    useEffect(() => { leaderboardRef.current = leaderboard; }, [leaderboard]);
    useEffect(() => { playerIdRef.current = playerId; }, [playerId]);
    useEffect(() => { connectionStatusRef.current = connectionStatus; }, [connectionStatus]);

    // --- Reset Game State ---
    const resetGameState = useCallback((keepConnectionStatus = false) => {
        setIsGameOver(false);
        setScore(0);
        playerWormRef.current = null;
        otherWormsRef.current.clear();
        foodRef.current = [];
        setLeaderboard([]);
        // Reset camera offset but don't immediately center on world origin
        cameraOffsetRef.current = { x: 0, y: 0 }; // Reset to 0,0
        initialCameraSetRef.current = false; // Reset initial camera flag

        joystickAngleRef.current = null;
        setShowJoystick(false);
        interactionActive.current = false;
        setIsZoomActive(false); // Reset zoom state
        zoomEndTimeRef.current = 0;
        isMagnetActiveRef.current = false; // Reset magnet state

        if (animationFrameIdRef.current) {
            cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = null;
              }
        if (!keepConnectionStatus) {
            setConnectionStatus(ConnectionStatus.IDLE);
            setConnectionErrorMsg('');
        }
    }, []); // Removed canvasSize from dependencies


    // --- Connect to Server ---
    const connectToServer = useCallback(() => {
        if (socketRef.current?.connected || connectionStatusRef.current === ConnectionStatus.CONNECTING) {
              return;
        }
        console.log("Attempting to connect to server:", SERVER_URL);
        setConnectionErrorMsg('');
        clearTimeout(connectionAttemptTimer.current);
        setConnectionStatus(ConnectionStatus.CONNECTING);
        resetGameState(true); // Reset state on connection attempt

        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        socketRef.current = io(SERVER_URL, {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 10000
        });

        const socket = socketRef.current;

        // --- Socket Event Listeners ---
        socket.on('connect', () => {
            console.log('Successfully connected! Socket ID:', socket.id);
            setConnectionStatus(ConnectionStatus.CONNECTED);
            setConnectionErrorMsg('');
            clearTimeout(connectionAttemptTimer.current);
        });
        socket.on('disconnect', (reason) => {
            console.warn('Disconnected:', reason);
            const wasConnected = connectionStatusRef.current === ConnectionStatus.CONNECTED;
            if (reason === 'io server disconnect') {
                setConnectionErrorMsg('Disconnected by server.');
                setConnectionStatus(ConnectionStatus.DISCONNECTED);
            } else if (reason === 'io client disconnect') {
                setConnectionErrorMsg('');
                setConnectionStatus(ConnectionStatus.IDLE);
            } else {
                setConnectionErrorMsg(`Connection lost: ${reason}. Reconnecting...`);
                setConnectionStatus(ConnectionStatus.RECONNECTING);
            }
            if (wasConnected || connectionStatusRef.current === ConnectionStatus.CONNECTING || connectionStatusRef.current === ConnectionStatus.RECONNECTING) {
                resetGameState(true);
            }
            setPlayerId(null);
            playerIdRef.current = null;
        });
        socket.on('connect_error', (err) => {
            console.error('Connection Error:', err.message);
            setConnectionErrorMsg(`Connection failed: ${err.message}. Retrying...`);
            setConnectionStatus(ConnectionStatus.RECONNECTING);
        });
        socket.on('reconnect_failed', () => {
            console.error('All reconnection attempts failed.');
            setConnectionErrorMsg('Connection failed. Server unavailable.');
            setConnectionStatus(ConnectionStatus.FAILED);
            resetGameState(true);
            socketRef.current = null;
            setPlayerId(null);
            playerIdRef.current = null;
        });
        socket.on('reconnect_attempt', (attempt) => {
            console.log(`Reconnect attempt ${attempt}...`);
            setConnectionStatus(ConnectionStatus.RECONNECTING);
            setConnectionErrorMsg(`Connection lost. Reconnecting (attempt ${attempt})...`);
        });
        socket.on('reconnect', (attempt) => {
            console.log(`Reconnected successfully on attempt ${attempt}! New ID: ${socket.id}`);
            setConnectionStatus(ConnectionStatus.CONNECTED);
            setConnectionErrorMsg('');
        });

        // --- Custom Game Event Listeners ---
        socket.on('welcome', (data) => {
            console.log('Received welcome event:', data);
            if (!data || !data.playerId) {
                console.error("Invalid 'welcome' data received from server. Disconnecting.");
                setConnectionErrorMsg("Invalid initial data from server.");
                socket.disconnect();
                setConnectionStatus(ConnectionStatus.FAILED);
                return;
            }
            setPlayerId(data.playerId);
            playerIdRef.current = data.playerId;
            worldSizeRef.current = data.worldSize || { width: WORLD_WIDTH, height: WORLD_HEIGHT };
         });

        socket.on('gameState', (state) => {
            if (!playerIdRef.current || connectionStatusRef.current !== ConnectionStatus.CONNECTED || isGameOver) return;
            if (!state) {
                console.warn("Empty gameState received. Skipping update.");
                return;
            }

            // Process food updates and check for power-ups
            const updatedFood = Array.isArray(state.food) ? state.food : [];
          
            const eatenFoodIds = new Set(); // Keep track of food eaten this frame

            // Check for food eaten by the player worm
            if (playerWormRef.current && state.eatenFood) {
                state.eatenFood.forEach(foodItem => {
                    if (foodItem.eaterId === playerIdRef.current) {
                        eatenFoodIds.add(foodItem.id);
                        // Check for special food types
                        if (foodItem.type === FOOD_TYPE_POWER) {
                            playerWormRef.current.applySpeedBoost();
                           
                        } else if (foodItem.type === FOOD_TYPE_ZOOM) {
                            setIsZoomActive(true); // <-- This sets the state
                            zoomEndTimeRef.current = Date.now() + POWER_UP_DURATION;
                            // Added logging for expiry time
                          
                        } else if (foodItem.type === FOOD_TYPE_MAGNET) {
                             isMagnetActiveRef.current = true;
                             // Magnet effect duration is tied to the power-up duration
                             setTimeout(() => {
                                 isMagnetActiveRef.current = false;
                               
                             }, POWER_UP_DURATION);
                           
                        }
                    }
                });
            }

            // Filter out eaten food from the food list
            foodRef.current = updatedFood.filter(foodItem => !eatenFoodIds.has(foodItem.id));


            const currentOtherWorms = otherWormsRef.current;
            const receivedWormIds = new Set();

            if (state.worms && typeof state.worms === 'object') {
                for (const id in state.worms) {
                    receivedWormIds.add(id);
                    const wormData = state.worms[id];
                    if (!wormData || !Array.isArray(wormData.segments)) {
                      
                        continue;
                    }

                    if (id === playerIdRef.current) {
                        if (!playerWormRef.current) {
                            playerWormRef.current = new Worm(id, wormData.segments, wormData.color, wormData.angle);
                          
                        } else {
                            playerWormRef.current.segments = wormData.segments;
                            playerWormRef.current.angle = wormData.angle;
                            // Use the updateColor method to handle derived colors
                            playerWormRef.current.updateColor(wormData.color);
                        }
                        const serverScore = wormData.score ?? 0;
                        if (scoreRef.current !== serverScore) {
                            setScore(serverScore);
                        }

                        // --- Initialize camera position on the first gameState update for the player ---
                        if (!initialCameraSetRef.current && playerWormRef.current.segments.length > 0) {
                             const playerHead = playerWormRef.current.segments[0];
                             cameraOffsetRef.current = {
                                 x: canvasSize.width / 2 - playerHead.x,
                                 y: canvasSize.height / 2 - playerHead.y
                             };
                             initialCameraSetRef.current = true;
                            
                        }


                    } else {
                        let otherWorm = currentOtherWorms.get(id);
                        if (!otherWorm) {
                            otherWorm = new Worm(id, wormData.segments, wormData.color, wormData.angle);
                           currentOtherWorms.set(id, otherWorm);
                        } else {
                            otherWorm.segments = wormData.segments;
                            otherWorm.angle = wormData.angle;
                            // Use the updateColor method
                            otherWorm.updateColor(wormData.color);
                            
                        }
                    }
                }
            } else {
                otherWormsRef.current.clear();
            }

            currentOtherWorms.forEach((worm, id) => {
                if (!receivedWormIds.has(id)) {
                    currentOtherWorms.delete(id);
                  
                }
            });

            if (Array.isArray(state.leaderboard)) {
                if (JSON.stringify(leaderboardRef.current) !== JSON.stringify(state.leaderboard)) {
                   
                    setLeaderboard(state.leaderboard);
                }
            } else if (leaderboardRef.current.length > 0) {
                setLeaderboard([]);
            }
        });


        socket.on('gameOver', (data) => {
            if (!isGameOver) {
                setIsGameOver(true);
                interactionActive.current = false;
                setShowJoystick(false);
             
               if (data?.score !== undefined) {
                    setScore(data.score);
                    scoreRef.current = data.score;
                    
                }
                if (animationFrameIdRef.current) {
                  cancelAnimationFrame(animationFrameIdRef.current);
                    animationFrameIdRef.current = null;
                }
                
            } else {
                 console.log("Ignoring gameOver event, game already over.");
            }
        });

    }, [resetGameState, isGameOver, canvasSize.width, canvasSize.height]); // Added canvasSize to dependencies

    useEffect(() => {
        isZoomActiveRef.current = isZoomActive;
         }, [isZoomActive]);


    // --- Effect for Initial Connection & Cleanup ---
    useEffect(() => {
        connectToServer();
        return () => {
            clearTimeout(connectionAttemptTimer.current);
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
            }
            setConnectionStatus(ConnectionStatus.IDLE);
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
        };
    }, [connectToServer]);


    // --- Effect for Loading Food Images ---
    useEffect(() => {
        const images = {};
         let attemptedLoads = 0;
         const totalImages = FOOD_IMAGE_TYPES;
         const checkLoadingComplete = () => {
              attemptedLoads++;
              if (attemptedLoads === totalImages) {
              }
         };
         const handleImageLoad = (imgType) => {
             images[imgType].loaded = true;
             checkLoadingComplete();
         };
         const handleImageError = (e, imgType, src) => {
           images[imgType].error = true;
              checkLoadingComplete();
         };
         for (let i = 1; i <= totalImages; i++) {
             const img = new Image();
             const imgSrc = `/food/${i}.png`;
             images[i] = { image: img, loaded: false, error: false };
             img.onload = () => handleImageLoad(i);
             img.onerror = (e) => handleImageError(e, i, imgSrc);
             img.src = imgSrc;
         }
         foodImagesRef.current = images;
     }, []);
 
 
 
    // --- Send Player Input (Joystick Angle) ---
    const sendPlayerInput = useCallback(() => {
        if (!socketRef.current || connectionStatusRef.current !== ConnectionStatus.CONNECTED || isGameOver || joystickAngleRef.current === null) {
            return;
        }
        const now = performance.now();
        if (now - lastJoystickSendTimeRef.current > JOYSTICK_SEND_INTERVAL) {
            // Include speed boost status in input if needed by server
            const isSpeedBoosting = playerWormRef.current?.isSpeedBoostActive() || false;
            socketRef.current.emit('playerInput', { angle: joystickAngleRef.current, isSpeedBoosting });
            lastJoystickSendTimeRef.current = now;
        }
    }, [isGameOver]);

    // Draws food items - Enhanced fallback style and magnet effect visualization
    // Added currentZoomFactor parameter
    const drawFood = useCallback((ctx, time, currentZoomFactor) => {
        const loadedImages = foodImagesRef.current;
        foodRef.current.forEach((f) => {
            if (!f) return;
            const foodRadius = f.radius || FOOD_RADIUS;
            const scaledFoodX = f.x * currentZoomFactor;
            const scaledFoodY = f.y * currentZoomFactor;
            const scaledFoodRadius = foodRadius * currentZoomFactor;
            
            const pulse = 1 + Math.sin(time * 5 + f.x) * 0.1;
            const scaledImageSize = scaledFoodRadius * 2 * pulse;
            const scaledDrawX = scaledFoodX - scaledImageSize / 2;
            const scaledDrawY = scaledFoodY - scaledImageSize / 2;

            const imageStatus = loadedImages[f.type];
            if (imageStatus && imageStatus.loaded && !imageStatus.error) {
                ctx.save();
                ctx.shadowColor = f.color || '#FFFF00';
                ctx.shadowBlur = 15 * currentZoomFactor * pulse;
                ctx.drawImage(imageStatus.image, scaledDrawX, scaledDrawY, scaledImageSize, scaledImageSize);
                ctx.restore();
            } else {
                const gradient = ctx.createRadialGradient(scaledFoodX, scaledFoodY, 0, scaledFoodX, scaledFoodY, scaledFoodRadius);
                gradient.addColorStop(0, adjustHSL(f.color, 20));
                gradient.addColorStop(0.7, f.color);
                gradient.addColorStop(1, 'transparent');
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(scaledFoodX, scaledFoodY, scaledFoodRadius * pulse, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }, [])








    // Draws worms - uses Worm class's draw method
    const drawWorms = useCallback((ctx, time, currentZoomFactor) => {
        otherWormsRef.current.forEach(worm => {
            // Pass zoom factor to worm's draw method
            if (worm) worm.draw(ctx, false, worm.angle, time, currentZoomFactor);
        });
        if (playerWormRef.current) {
            const lookAngle = joystickAngleRef.current ?? playerWormRef.current.angle;
            // Pass zoom factor to player worm's draw method
            playerWormRef.current.draw(ctx, true, lookAngle, time, currentZoomFactor);
        }
    }, []); // Added currentZoomFactor to dependencies


    // Draws background with solid color
    const drawBackground = useCallback((ctx, worldWidth, worldHeight,color, currentZoomFactor) => {
        // Draw a solid background color across the entire world
        ctx.fillStyle = color; // Using the same dark color as the body background
         ctx.strokeStyle = 'rgba(178, 164, 222, 0.5)'; // Very subtle border
         ctx.shadowColor = 'rgba(16, 19, 200, 2)';
        ctx.shadowBlur = 8 * currentZoomFactor; // Scale shadow blur
        
        ctx.fill();  
    ctx.lineWidth = 30;
    
    ctx.strokeRect(1, 1, worldWidth - 2, worldHeight - 2);
      ctx.fillRect(0, 0, worldWidth * currentZoomFactor, worldHeight * currentZoomFactor); // Fill the entire world dimensions
    }, []);

    // --- Game Loop ---
     // --- Game Loop ---
    // --- Game Loop ---
      // --- Game Loop ---
     // --- Game Loop ---
    const gameLoop = useCallback((currentTime) => {
        const color = backgroundRef.current;
       const canvas = canvasRef.current;
        const time = currentTime / 1000;
        const now = Date.now();

        if (!canvas || connectionStatusRef.current !== ConnectionStatus.CONNECTED || isGameOver) {
            animationFrameIdRef.current = null;
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            animationFrameIdRef.current = null;
            return;
        }

        // Check for power-up expiry
        // Read from ref here
        if (isZoomActiveRef.current && now > zoomEndTimeRef.current) {
            setIsZoomActive(false);
       }
        // Magnet effect is handled by a timeout when activated

        sendPlayerInput();

        const playerHead = playerWormRef.current?.segments?.[0];
        // Calculate currentZoomFactor based on ref
        let currentZoomFactor = isZoomActiveRef.current ? ZOOM_OUT_FACTOR : 1.0;

        // Add logging for zoom state (from ref) and factor
        ctx.clearRect(0, 0  , canvas.width, canvas.height);
    

        // --- Camera Transformation (Manual Zoom) ---
        ctx.save(); // Save the default identity matrix state

        // Calculate the translation needed to center the player's *scaled* head position.
        let translateX = canvas.width / 2;
        let translateY = canvas.height / 2;

        if (playerHead) {
             // Translate the canvas by the difference between the canvas center
             // and the scaled player head position.
             translateX = canvas.width / 2 - playerHead.x * currentZoomFactor;
             translateY = canvas.height / 2 - playerHead.y * currentZoomFactor;
        }

        // Apply only the translation transformation
        ctx.translate(translateX, translateY);

        // The scaling is now handled manually within the drawing functions.
      

        // Draw game elements (these use world coordinates, drawing functions will apply manual scale)
        drawBackground(ctx, worldSizeRef.current.width, worldSizeRef.current.height,color, currentZoomFactor); // Pass zoom factor
        drawFood(ctx, time, currentZoomFactor); // Pass zoom factor
        drawWorms(ctx, time, currentZoomFactor); // Pass zoom factor

        ctx.restore(); // Restore to the original canvas transformation state


        // --- Magnet Effect: Pull food towards the player ---
        // This logic should be outside the main camera transformation block
        // as it modifies the food positions in world coordinates *before* drawing.
        // This part doesn't need manual scaling applied to the food positions themselves,
        // as they are world coordinates updated by the server.
        if (isMagnetActiveRef.current && playerHead) {
            const magnetRadius = playerWormRef.current.getCurrentRadius() * MAGNET_RADIUS_MULTIPLIER;
            foodRef.current.forEach(foodItem => {
                const distToFood = Math.sqrt(Math.pow(foodItem.x - playerHead.x, 2) + Math.pow(foodItem.y - playerHead.y, 2));
                if (distToFood < magnetRadius) {
                    // Calculate direction vector towards player head
                    const angleToPlayer = Math.atan2(playerHead.y - foodItem.y, playerHead.x - foodItem.x);
                    const pullForce = (magnetRadius - distToFood) / magnetRadius; // Stronger pull closer to worm
                    const pullSpeed = 5 * pullForce; // Adjust pull speed as needed

                    foodItem.x += Math.cos(angleToPlayer) * pullSpeed;
                    foodItem.y += Math.sin(angleToPlayer) * pullSpeed;
                }
            });
        }


        // Draw UI Elements (these should not be affected by zoom)
        // They are drawn after ctx.restore() which resets the transformation.
        //drawCanvasBorder(ctx, canvas);
        if (playerWormRef.current) {
            // The minimap still uses the cameraOffsetRef to show the viewport
            // We need to update cameraOffsetRef based on player position for the minimap.
            // This calculation still needs the zoom factor to correctly represent the viewport size/position.
             if (playerHead) {
                 cameraOffsetRef.current = {
                     x: canvas.width / 2 - playerHead.x * currentZoomFactor,
                     y: canvas.height / 2 - playerHead.y * currentZoomFactor
                 };
             }
            drawMinimap(ctx, playerWormRef, otherWormsRef, foodRef, worldSizeRef, cameraOffsetRef, canvas, currentZoomFactor); // Pass zoom factor to minimap
        }
        if (leaderboardRef.current.length > 0) {
            drawLeaderboard(ctx, leaderboardRef.current, canvas, playerIdRef.current);
        }
        drawScore(ctx, scoreRef.current, canvas);

        // Draw Power Up Icons
        // Pass the state value here, as the UI drawing is tied to the render cycle
        drawPowerUpIcons(ctx, canvas, playerWormRef.current?.isSpeedBoostActive(), isZoomActive, isMagnetActiveRef.current);
        

        animationFrameIdRef.current = requestAnimationFrame(gameLoop);

    }, [isGameOver, sendPlayerInput, drawBackground, drawFood, drawWorms, isZoomActive, canvasSize.width, canvasSize.height]); // isZoomActive is still a dependency for useCallback

    // --- Game Initialization ---
    // This function now primarily starts the game loop and resets UI state
    const initGame = useCallback(() => {
        if (connectionStatusRef.current !== ConnectionStatus.CONNECTED || !playerIdRef.current || isGameOver) {
           return;
        }
        setIsGameOver(false);
        joystickAngleRef.current = null;
        setShowJoystick(false);
        interactionActive.current = false;
        setIsZoomActive(false); // Reset zoom state on init
        zoomEndTimeRef.current = 0;
        isMagnetActiveRef.current = false; // Reset magnet state on init
        // Initial camera position is now set in the gameState handler


        if (!animationFrameIdRef.current) {
            lastFrameTimeRef.current = performance.now();
            animationFrameIdRef.current = requestAnimationFrame(gameLoop);
        } else {
             console.log("Game loop already running.");
        }
    }, [isGameOver, gameLoop]); // Removed canvasSize from dependencies


    // --- Create Background Pattern Canvas ---
    // Keeping this effect, but it's no longer used for drawing the main background grid.
    // It could be repurposed or removed if not needed for other patterns.
    useEffect(() => {
        const patternCanvas = document.createElement('canvas');
        const patternCtx = patternCanvas.getContext('2d');
        const size = BACKGROUND_GRID_SIZE; // Use constant
        patternCanvas.width = size;
        patternCanvas.height = size;

        if (patternCtx) {
            // Dark background base for the pattern tile
            patternCtx.fillStyle = '#100f1f'; // Slightly darker than main background
            patternCtx.fillRect(0, 0, size, size);
            // Grid lines
            patternCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; // Very faint white lines
            patternCtx.lineWidth = 1;
            // Draw lines slightly offset to avoid seams? (Might not be necessary)
            patternCtx.beginPath();
            patternCtx.moveTo(size - 0.5, 0);
            patternCtx.lineTo(size - 0.5, size);
            patternCtx.moveTo(0, size - 0.5);
            patternCtx.lineTo(size, size - 0.5);
            // FIX: Changed ctx.stroke() to patternCtx.stroke() here
            patternCtx.stroke();
            backgroundPatternCanvasRef.current = patternCanvas;
         } else {
             console.error("Failed to get context for background pattern canvas.");
        }
        // No cleanup needed, ref holds the canvas
    }, []); // Run once on mount


    // --- Drawing Functions ---

    // Draws food items - Enhanced fallback style and magnet effect visualization
   

    // --- Effect for Starting/Stopping Game Loop ---
    useEffect(() => {
        if (connectionStatus === ConnectionStatus.CONNECTED && playerId && !isGameOver) {
            if (!animationFrameIdRef.current) {
                 initGame();
            }
        } else if (animationFrameIdRef.current) {
           cancelAnimationFrame(animationFrameIdRef.current);
             animationFrameIdRef.current = null;
        }
    }, [playerId, connectionStatus, isGameOver, initGame]);


    // --- Effect for Window Resize ---
    useEffect(() => {
        const handleResize = () => {
            const newWidth = window.innerWidth;
            const newHeight = window.innerHeight;
            setCanvasSize({ width: newWidth, height: newHeight });
            console.log(`Window resized to: ${newWidth}x${newHeight}`);
            // Recalculate initial camera offset on resize if player exists and initial camera was set
            if (playerIdRef.current && playerWormRef.current?.segments?.length > 0 && initialCameraSetRef.current) {
                 const playerHead = playerWormRef.current.segments[0];
                 // Recalculate based on the new canvas size to keep the player centered
                 cameraOffsetRef.current = {
                     x: newWidth / 2 - playerHead.x,
                     y: newHeight / 2 - playerHead.y
                 };
                 console.log("Camera offset recalculated on resize.");
            }
        };
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []); // Empty dependency array means this effect runs once on mount and cleans up on unmount


    // --- Joystick Input Handlers ---
    const handleJoystickMove = useCallback((data) => {
        joystickAngleRef.current = data.angle;
    }, []);
    const handleJoystickStop = useCallback(() => {
        // Keep last angle for continuous movement
    }, []);


    // --- Restart Game / Reconnect Logic ---
    const handleRestart = useCallback(() => {
        if (socketRef.current && connectionStatusRef.current === ConnectionStatus.CONNECTED && isGameOver) {
            socketRef.current.emit('respawn');
        } else if (connectionStatusRef.current === ConnectionStatus.FAILED || connectionStatusRef.current === ConnectionStatus.DISCONNECTED) {
            connectToServer();
        } else {
             console.log("Restart requested in unexpected state:", connectionStatusRef.current, "GameOver:", isGameOver);
        }
    }, [connectToServer, isGameOver]);


    // --- Interaction Start Handler (for dynamic joystick) ---
    const handleInteractionStart = useCallback((e) => {
        if (connectionStatusRef.current !== ConnectionStatus.CONNECTED || isGameOver || interactionActive.current) {
            return;
        }
        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Updated UI collision check (adjust values if needed)
        const isOverMinimap = clientX < 220 && clientY > window.innerHeight - 240; // Larger check area
        const isOverLeaderboard = clientX > window.innerWidth - 290 && clientY < 340; // Larger check area
        const isOverScore = clientX < 170 && clientY < 80; // Larger check area
         // Check if over power-up icons (adjust coordinates based on drawPowerUpIcons)
        const iconSize = 40;
        const padding = 15;
        const startX = canvasSize.width / 2 - (iconSize * 1.5 + padding);
        const startY = canvasSize.height - iconSize - padding;
        const iconAreaWidth = (iconSize + padding) * 3 - padding;
        const iconAreaHeight = iconSize;
        const isOverIcons = clientX > startX && clientX < startX + iconAreaWidth &&
                           clientY > startY && clientY < startY + iconAreaHeight;


        if (isOverMinimap || isOverLeaderboard || isOverScore || isOverIcons) {
            return;
        }

        interactionActive.current = true;
        setJoystickPosition({ x: clientX, y: clientY });
        setShowJoystick(true);
    }, [isGameOver, canvasSize.width, canvasSize.height]);

  
    // --- Interaction End Handler (for dynamic joystick) ---
    useEffect(() => {
        const handleGlobalInteractionEnd = (e) => {
            if (interactionActive.current) {
                interactionActive.current = false;
                setShowJoystick(false);
                if (handleJoystickStop) {
                    handleJoystickStop();
                }
            }
        };
        window.addEventListener('mouseup', handleGlobalInteractionEnd);
        window.addEventListener('touchend', handleGlobalInteractionEnd);
        window.addEventListener('touchcancel', handleGlobalInteractionEnd);
        return () => {
            window.removeEventListener('mouseup', handleGlobalInteractionEnd);
            window.removeEventListener('touchend', handleGlobalInteractionEnd);
            window.removeEventListener('touchcancel', handleGlobalInteractionEnd);
        };
    }, [handleJoystickStop]);


    // --- Render Overlays ---
   

    // --- Main App Render ---
    return (
        <div
            className="flex items-center justify-center min-h-screen m-0 overflow-hidden font-poppins bg-[#100f1f] relative select-none" // Updated background to match pattern base
            style={{ overscrollBehavior: 'none', touchAction: 'none' }}
            onMouseDown={handleInteractionStart}
            onTouchStart={handleInteractionStart}
        >
            <div className="relative overflow-hidden" style={{ width: canvasSize.width, height: canvasSize.height }}>
                <canvas
                    ref={canvasRef}
                    width={canvasSize.width}
                    height={canvasSize.height}
                    style={{ display: 'block', background: backgroundRef.current }} // Match pattern base
                />
            </div>

            {/* Render joystick with updated styling */}
            {showJoystick && connectionStatus === ConnectionStatus.CONNECTED && !isGameOver && (
                <VirtualJoystick
                    initialPosition={joystickPosition}
                    onMove={handleJoystickMove}
                    onStop={handleJoystickStop}
                    // Use updated defaults or override here
                    // size={JOYSTICK_SIZE}
                    // stickSize={STICK_SIZE}
                    // baseColor='rgba(100, 100, 120, 0.35)'
                    // stickColor='rgba(255, 255, 255, 0.6)'
                />
            )}

                     {/* Game Over Overlay: Render directly based on isGameOver state */}
            {isGameOver && (
                <GameOverOverlay
                    // Pass score using the ref's current value for the final display
                    score={scoreRef.current}
                    
                    connectionStatus={connectionStatus} // Pass current connection status
                    onRestart={handleRestart} // Pass the restart handler
                />
            )}

            {/* Connection Status Overlay: Render based on status, but NOT if game is over */}
            {!isGameOver && (
                <ConnectionOverlay
                    connectionStatus={connectionStatus}
                    connectionErrorMsg={connectionErrorMsg}
                    onRetry={handleRestart} // Use the same handler for retry/reconnect
                />
            )}
        </div>
    )
}


// --- Utility Drawing/Component Functions (Updated Styles) ---

// Draws canvas border (subtler)
// function drawCanvasBorder(ctx, canvas) {
//     ctx.save();
//     ctx.resetTransform();
//     ctx.strokeStyle = 'rgba(150, 150, 170, 0.1)'; // Very subtle border
//     ctx.lineWidth = 1;
//     ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
//     ctx.restore();
// }

// Draws score (Wormszone style)
function drawScore(ctx, score, canvas) {
    ctx.save();
    ctx.resetTransform();

    const x = 30; // Position from left
    const y = 40; // Position from top
    const text = `Score: ${score}`;
    const paddingX = 15;
    const paddingY = 8;
    const fontSize = 15;
    const fontWeight = '300'; // Semibold
    const fontFamily = '"Poppins", georgia'; // Ensure Poppins is loaded or use fallback
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

    const textMetrics = ctx.measureText(text);
    const boxWidth = textMetrics.width + paddingX * 2;
    const boxHeight = fontSize + paddingY * 2;

    // Draw semi-transparent background box
    ctx.fillStyle = 'rgba(225, 225, 225, 0.4)'; // Darker transparent background
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x - paddingX, y - paddingY, boxWidth, boxHeight, 8); // Rounded corners
    } else {
        ctx.rect(x - paddingX, y - paddingY, boxWidth, boxHeight);
    }
    ctx.fill();

    // Draw score text
    ctx.fillStyle = 'black'; // White text
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle'; // Center text vertically
    ctx.fillText(text, x, y + boxHeight / 2 - paddingY); // Adjust Y position for middle alignment

    ctx.restore();
}

// Draws leaderboard (Wormszone style)
function drawLeaderboard(ctx, leaderboard, canvas, currentPlayerId) {
    
    ctx.save();
    ctx.resetTransform();

    const width = 170; // Slightly wider
    const rowHeight = 24.5;
    const maxRows = 10; // Show more rows potentially
    const padding = 10;
    const titleHeight = 25;
    const x = canvas.width - width - padding;
    const y = padding;
    const displayRows = Math.min(leaderboard.length, maxRows);
    const height = titleHeight + (displayRows * rowHeight) + padding; // Adjusted height calculation

    // Draw background box
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)'; // Slightly darker background

    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, 10); // More rounded corners
    } else {
        ctx.rect(x, y, width, height);
    }
    ctx.fill();
    // Add subtle border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();


    // Draw title
    ctx.fillStyle = 'WHITE';
    ctx.font = '16px "Poppins", georgia';
    ctx.textAlign = 'center'; // Center title
    ctx.textBaseline = 'middle';
    ctx.fillText('Leaderboard', x + width / 2, y + titleHeight / 2);

    // Sort players
    const sortedPlayers = [...leaderboard]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, maxRows);
        
    // Draw player rows
    ctx.font = '11px "Poppins", georgia'; // Slightly larger font
    sortedPlayers.forEach((player, index) => {
        const rowY = y + titleHeight + index * rowHeight;
        const isPlayer = player.id === currentPlayerId;
        const name = player.name || `Worm ${player.id?.substring(0, 4) || '????'}`;
        const scoreText = (player.score ?? 0).toLocaleString(); // Format score with commas

        if (isPlayer) {
            ctx.fillStyle = player.color; // Slightly stronger highlight
            
            ctx.fillRect(x + 1, rowY, width - 2, rowHeight-2); // Inset highlight slightly
        }else{
            // Highlight current player's row
            ctx.fillStyle = player.color; // Slightly stronger highlight
            
            ctx.fillRect(x + 1, rowY, width - 2, rowHeight-2); // Inset highlight slightly
        }
       
       
    
        // Player rank and name (left-aligned)
        ctx.fillStyle = isPlayer ? "white" : "black";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${index + 1}. ${name}`, x + padding, rowY + rowHeight / 2);

        // Player score (right-aligned)
        ctx.fillStyle = isPlayer ? 'black' : 'black'; // Keep cyan score for others
        ctx.textAlign = 'right';
        ctx.font = '11px "Poppins", georgia'; // Bold score
        ctx.fillText(scoreText, x + width - padding, rowY + rowHeight / 2);
        ctx.font = '11px "Poppins", georgia'; // Reset font weight for next name
    });
}

// Draws minimap (Wormszone style)
function drawMinimap(ctx, playerWormRef, otherWormsRef, foodRef, worldSizeRef, cameraOffsetRef, canvas, currentZoomFactor) {
    ctx.save();
    ctx.resetTransform(); // Ignore camera offset for UI elements

    const minimapSize = 170; // Size of the square minimap
    const padding = 20; // Padding from canvas edges
    const minimapX = padding; // Position from left
    const minimapY = canvas.height - minimapSize - padding; // Position from bottom

    const worldWidth = worldSizeRef.current.width;
    const worldHeight = worldSizeRef.current.height;

    // Avoid division by zero if world size isn't set
    if (worldWidth <= 0 || worldHeight <= 0) {
        ctx.restore();
        return;
    }

    // Scaling factors from world coordinates to minimap coordinates
    const scaleX = minimapSize / worldWidth;
    const scaleY = minimapSize / worldHeight;

    // Dot sizes
    const playerDotRadius = 5;
    const otherPlayerDotRadius = 3;
    const foodDotRadius = 1; // Smaller food dots

    // Draw minimap background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'; // Slightly darker background
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; // Faint white border
    ctx.lineWidth = 1;
    ctx.beginPath();
    const borderRadius = 8;
    // Manual rounded rect
    ctx.moveTo(minimapX + borderRadius, minimapY);
    ctx.lineTo(minimapX + minimapSize - borderRadius, minimapY);
    ctx.arcTo(minimapX + minimapSize, minimapY, minimapX + minimapSize, minimapY + borderRadius, borderRadius);
    ctx.lineTo(minimapX + minimapSize, minimapY + minimapSize - borderRadius);
    ctx.arcTo(minimapX + minimapSize, minimapY + minimapSize, minimapX + minimapSize - borderRadius, minimapY + minimapSize, borderRadius);
    ctx.lineTo(minimapX + borderRadius, minimapY + minimapSize);
    ctx.arcTo(minimapX, minimapY + minimapSize, minimapX, minimapY + minimapSize - borderRadius, borderRadius);
    ctx.lineTo(minimapX, minimapY + borderRadius);
    ctx.arcTo(minimapX, minimapY, minimapX + borderRadius, minimapY, borderRadius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Draw elements within the minimap ---
    // Clip drawing to the minimap bounds (use the rounded rect path for clipping)
    ctx.clip(); // Clip to the path defined above

    // Draw food dots (optional, consider performance impact)
    // Limit the number of food dots drawn for performance
    const maxFoodDots = 100;
    ctx.fillStyle = '#FFEB3B'; // Yellow for food
    ctx.globalAlpha = 0.6; // Make food slightly transparent
    const food = foodRef.current || [];
    const foodStep = Math.max(1, Math.floor(food.length / maxFoodDots)); // Draw roughly maxFoodDots
    for (let i = 0; i < food.length; i += foodStep) {
        const f = food[i];
        if (!f || typeof f.x !== 'number' || typeof f.y !== 'number') continue;
        const fx = minimapX + f.x * scaleX;
        const fy = minimapY + f.y * scaleY;
        // Basic culling (already handled by clipping)
        ctx.beginPath();
        ctx.arc(fx, fy, foodDotRadius, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0; // Reset alpha


    // Draw other player dots
    ctx.fillStyle = '#B0BEC5'; // Light grey for other players
    const otherWorms = Array.from(otherWormsRef.current.values());
    for (let worm of otherWorms) {
        if (worm?.segments?.[0]) { // Check if worm and head segment exist
            const head = worm.segments[0];
            const x = minimapX + head.x * scaleX;
            const y = minimapY + head.y * scaleY;
            ctx.beginPath();
            ctx.arc(x, y, otherPlayerDotRadius, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Draw player dot (on top)
    const playerWorm = playerWormRef.current;
    if (playerWorm?.segments?.[0]) {
        const head = playerWorm.segments[0];
        const x = minimapX + head.x * scaleX;
        const y = minimapY + head.y * scaleY;
        ctx.fillStyle = playerWorm.color || '#FFFFFF'; // Use player's color or white
        ctx.beginPath();
        ctx.arc(x, y, playerDotRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white'; // White outline for visibility
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // --- Draw viewport rectangle ---
    // Calculate viewport position and size in world coordinates based on camera offset and zoom
    const cameraOffset = cameraOffsetRef.current; // This is the current ctx.translate offset
    const canvasSize = { width: canvas.width, height: canvas.height };

    // The top-left corner of the visible world area (world coords)
    const viewLeftWorld = -cameraOffset.x / currentZoomFactor;
    const viewTopWorld = -cameraOffset.y / currentZoomFactor;
    // The width/height of the visible world area (world coords)
    const viewWidthWorld = canvasSize.width / currentZoomFactor;
    const viewHeightWorld = canvasSize.height / currentZoomFactor;

    // Convert viewport world coords to minimap coords
    const mapLeft = minimapX + viewLeftWorld * scaleX;
    const mapTop = minimapY + viewTopWorld * scaleY;
    const mapWidth = viewWidthWorld * scaleX;
    const mapHeight = viewHeightWorld * scaleY;

    // Draw the viewport rectangle (don't need to clamp, clipping handles it)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; // Bright white for viewport
    ctx.lineWidth = 1.5; // Thinner viewport line
    ctx.strokeRect(mapLeft, mapTop, mapWidth, mapHeight);

    ctx.restore(); // Restore context (removes clipping)
}







function drawPowerUpIcons(ctx, canvas, isSpeedBoostActive, isZoomActive, isMagnetActive) {
    ctx.save();
    ctx.resetTransform(); // Draw relative to canvas, not world

    const iconSize = 36; // Slightly smaller icons
    const padding = 12; // Padding between icons
    const bottomPadding = 20; // Padding from bottom edge
    const numIcons = 3;
    const totalWidth = (iconSize * numIcons) + (padding * (numIcons - 1));
    const startX = canvas.width / 2 - totalWidth / 2; // Center the group horizontally
    const startY = canvas.height - iconSize - bottomPadding; // Position from bottom

    // Helper to draw a single icon with background and text/symbol
    const drawIcon = (x, y, bgColor, borderColor, isActive, iconText, textColor = '#FFFFFF') => {
        // Background circle
        ctx.fillStyle = isActive ? bgColor : 'rgba(50, 50, 50, 0.5)'; // Active color or dark grey
        ctx.strokeStyle = isActive ? borderColor : 'rgba(150, 150, 150, 0.5)'; // Active border or light grey
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x + iconSize / 2, y + iconSize / 2, iconSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Draw icon text/symbol
        ctx.fillStyle = isActive ? textColor : 'rgba(200, 200, 200, 0.8)'; // White/light text when active, dimmer when inactive
        ctx.font = `bold ${iconSize * 0.5}px "Poppins", sans-serif`; // Scale font size with icon size
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(iconText, x + iconSize / 2, y + iconSize / 2 + 1); // Slight offset for better centering
    };

    // Define icon properties
    const icons = [
        { active: isSpeedBoostActive, color: 'rgba(0, 220, 0, 0.7)', border: '#00FF00', text: 'S', textColor: '#000000' }, // Speed (Green)
        { active: isZoomActive, color: 'rgba(255, 165, 0, 0.7)', border: '#FFA500', text: 'Z', textColor: '#000000' }, // Zoom (Orange)
        { active: isMagnetActive, color: 'rgba(0, 100, 255, 0.7)', border: '#0064FF', text: 'M', textColor: '#FFFFFF' }, // Magnet (Blue)
    ];

    // Draw each icon
    icons.forEach((icon, index) => {
        const currentX = startX + index * (iconSize + padding);
        drawIcon(currentX, startY, icon.color, icon.border, icon.active, icon.text, icon.textColor);
    });

    ctx.restore();
}





// Draws power up icons


function GameOverOverlay({ score, connectionStatus, onRestart }) {
    // Add a log inside the component function itself
    console.log("Rendering GameOverOverlay component. Score:", score, "Status:", connectionStatus);

    // Determine button text based on connection status when game ended
    const buttonText = (connectionStatus === ConnectionStatus.CONNECTED || connectionStatus === ConnectionStatus.DISCONNECTED || connectionStatus === ConnectionStatus.IDLE)
                       ? 'Play Again'
                       : 'Try Reconnecting';

    return (
        // Use Tailwind for layout and styling
        // `inset-0` makes it cover the parent (the main app div)
        // `z-30` ensures it's above the canvas and joystick
        <div
            // REMOVED hardcoded style={{ width: 1536, height: 227 }}
            className="absolute inset-0 bg-black bg-opacity-80 flex flex-col justify-center items-center text-white z-30 backdrop-blur-md transition-opacity duration-500 ease-in-out font-poppins"
        >
            <h1 className="text-6xl font-bold text-red-500 mb-4" style={{ textShadow: '2px 2px 4px rgba(0,0,0,0.7)' }}>
                Game Over!
            </h1>
            <p className="text-3xl mb-8">
                Final Score: <span className="font-semibold text-cyan-300">{score.toLocaleString()}</span>
            </p>
            <button
                onClick={onRestart}
                className="py-3 px-8 text-xl font-semibold text-white bg-gradient-to-br from-green-500 to-green-700 rounded-lg cursor-pointer transition-all duration-300 ease-in-out shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 active:shadow-md border-2 border-green-800 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-opacity-75"
            >
                {buttonText}
            </button>
        </div>
    );
}

// ConnectionOverlay: Displays connection status messages (Connecting, Failed, etc.)
function ConnectionOverlay({ connectionStatus, connectionErrorMsg, onRetry }) {
     // Add a log inside the component function
     // console.log("Rendering ConnectionOverlay component. Status:", connectionStatus);

    // Determine content based on connection status
    let content = null;
    switch (connectionStatus) {
        case ConnectionStatus.CONNECTING:
        case ConnectionStatus.RECONNECTING:
            content = (
                <>
                    <p className="mb-3 text-lg">{connectionErrorMsg || (connectionStatus === ConnectionStatus.CONNECTING ? 'Connecting to server...' : 'Attempting to reconnect...')}</p>
                    {/* Simple spinner */}
                    <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-white"></div>
                </>
            );
            break;
        case ConnectionStatus.FAILED:
        case ConnectionStatus.DISCONNECTED: // Show retry option also if disconnected by server
             // Only show if there's an error message or it's a failed state
             if (connectionErrorMsg || connectionStatus === ConnectionStatus.FAILED) {
                content = (
                    <>
                        <p className="text-red-400 font-semibold mb-6 px-4 text-center text-lg">{connectionErrorMsg || 'Connection Failed'}</p>
                        <button
                            onClick={onRetry}
                            className="py-2 px-6 text-lg font-semibold text-gray-800 bg-gradient-to-r from-white to-gray-200 rounded-full cursor-pointer transition-all duration-300 ease-in-out shadow-md hover:shadow-lg active:shadow-sm focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-opacity-75"
                        >
                            {connectionStatus === ConnectionStatus.FAILED ? 'Retry Connection' : 'Reconnect'}
                        </button>
                    </>
                );
             }
            break;
        case ConnectionStatus.IDLE:
             // Optionally show something in IDLE state, e.g., a "Connecting..." message
             // or just return null if nothing should be shown before the first attempt.
             content = (
                 <p className="text-lg text-gray-400">Initializing...</p>
             );
             break;
        case ConnectionStatus.CONNECTED:
        default:
            // No overlay needed when connected
            return null;
    }

    // Render the overlay container only if there's content to display
    return (
        <div className="absolute inset-0 bg-black bg-opacity-70 flex flex-col justify-center items-center text-white z-20 backdrop-blur-sm font-poppins pointer-events-none">
            {/* Add pointer-events-auto to the button if interaction is needed */}
            <div className="p-6 bg-gray-800 bg-opacity-50 rounded-lg shadow-xl pointer-events-auto text-center">
                 {content}
            </div>
        </div>
    );
}
export default App;
