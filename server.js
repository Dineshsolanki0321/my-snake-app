
const express = require("express");
const http = require('http');
const { Server } = require('socket.io');
const path = require("path");
const cors = require("cors");

// --- Express App Setup ---
const app = express();
const reactBuildPath = path.join(__dirname, "build"); // Assuming a React build folder


// --- Middleware ---
app.use(cors({
    origin: "*", // WARNING: Allow all origins - restrict in production!
    methods: ["GET", "POST"],
    transports: ["websocket", "polling"]
}));
app.use(express.static(reactBuildPath));

// --- Game Constants ---
const PORT = process.env.PORT || 4000;
// Increased tick rate for smoother server-side simulation, adjust if it causes high server CPU
const TICK_RATE_MS = 1000 / 75; // Target 60 updates per second

// World Properties
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const WORLD_GROUND_Z = 0; // Define a constant Z level for the ground plane

// Worm Properties
const WORM_INITIAL_LENGTH = 100; // Starting number of segments
const WORM_SEGMENT_RADIUS = 8;
const WORM_SPEED = 2; // Base speed (world units per tick)
const WORM_TURN_SPEED = 0.05; // Radians per tick
const WORM_SEGMENT_DISTANCE = WORM_SEGMENT_RADIUS * 0.8; // Distance between segment centers

// Food Properties
const FOOD_RADIUS = 12;
const MAX_FOOD = 50;  // Increased max food for more gameplay, adjust based on performance
const FOOD_SCORE = 5;
const FOOD_DROP_CHANCE = 0.6; // Increased chance for dead worms to drop food
const FOOD_DROP_INTERVAL = 5; // Drop food from every 5th segment
const MIN_FOOD_SPAWN_DISTANCE_SQ = Math.pow(FOOD_RADIUS * 4, 2); // Min squared distance between new food and existing food/worms
const FOOD_IMAGE_TYPES = 36; // Assuming you have images 1.png through 36.png

// --- Special Food Types (Matching client-side constants) ---
const FOOD_TYPE_POWER = 15; // Corresponds to 15.png for speed boost
const FOOD_TYPE_ZOOM = 12; // Corresponds to 12.png for zoom out (client-side effect)
const FOOD_TYPE_MAGNET = 7; // Corresponds to 7.png for magnet effect

// --- Power Up Settings (Server-side relevant) ---
const SPEED_BOOST_FACTOR = 1.6; // 80% speed increase (increased slightly)
const POWER_UP_DURATION_MS = 10000; // 10 seconds in milliseconds (Server needs this for speed boost expiry)
const MAGNET_RADIUS_MULTIPLIER = 6; // Magnet picks up food from 6x the normal distance (Server needs this for collision)

// Collision Detection (Squared XY distances for faster comparison)
const FOOD_COLLISION_THRESHOLD_SQUARED = Math.pow(WORM_SEGMENT_RADIUS + FOOD_RADIUS, 2);
const SELF_COLLISION_START_INDEX = 6; // Increased start index to prevent immediate self-collision
const SELF_COLLISION_THRESHOLD_SQUARED = Math.pow(WORM_SEGMENT_RADIUS * 1.2, 2); // Slightly reduced threshold
const OTHER_COLLISION_THRESHOLD_SQUARED = Math.pow(WORM_SEGMENT_RADIUS * 1.5, 2); // Slightly reduced threshold

// --- AI Bot Constants ---
const BOT_COUNT = 15; // Number of bots to try and maintain, adjust based on server performance
const BOT_NAME_PREFIX = "AI_Bot";
const BOT_TARGET_UPDATE_INTERVAL_TICKS = 30; // How many ticks before a bot re-evaluates its main target (e.g., nearest food)
const BOT_AVOIDANCE_DISTANCE = WORM_SEGMENT_RADIUS * 15; // How far ahead bots look for collisions (increased)
const BOT_AVOIDANCE_ANGLE = Math.PI / 4; // Angle to turn when avoiding (increased)
const BOT_BOUNDARY_AVOID_MARGIN = 100; // How far from boundary bots start turning (increased)
const BOT_RANDOM_TURN_CHANCE = 0.02; // Chance for bot to make a small random turn when no target

// --- Game State ---
// players: { socketId: PlayerObject }
// PlayerObject: { id, name, isBot, worm: { segments, angle, targetAngle, color, score, isAlive, hasSpeedBoost, speedBoostEndTime, isMagnetActive, botState: { targetFoodId, ticksUntilTargetUpdate } } }
let players = {};
// food: Array of { x, y, z, color, radius, id, type } - Added ID and Type for easier tracking and client rendering
let food = [];
// eatenFoodThisTick: Array of { id, eaterId, type } - To inform clients which food was eaten this tick
let eatenFoodThisTick = [];


let nextFoodId = 0; // Simple food ID counter
let nextBotId = 0; // Simple bot ID counter

// --- HTTP Server and Socket.IO Setup ---
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"], transports: ["websocket", "polling"] }
});

// --- Utility Functions ---
function getRandomColor() { return `hsl(${Math.random() * 360}, 80%, 60%)`; }
function getRandomSpawnPositionXY(margin = 100) {
    const x = Math.random() * (WORLD_WIDTH - 2 * margin) + margin;
    const y = Math.random() * (WORLD_HEIGHT - 2 * margin) + margin;
    return { x, y };
}

/**
 * Checks if a potential spawn point is too close to existing food or worms.
 * @param {number} x - Potential X coordinate.
 * @param {number} y - Potential Y coordinate.
 * @returns {boolean} True if the position is clear, false otherwise.
 */
function isSpawnPositionClear(x, y) {
    // Check against existing food
    for (const f of food) {
        const dx = x - f.x;
        const dy = y - f.y;
        if ((dx * dx + dy * dy) < MIN_FOOD_SPAWN_DISTANCE_SQ) {
            return false; // Too close to other food
        }
    }
    // Check against worm segments
    for (const pId in players) {
        const player = players[pId];
        // Only check living worms
        if (player.worm?.isAlive && player.worm?.segments) {
            // Optimization: Only check head segments for faster check
             const head = player.worm.segments[0];
             const dx = x - head.x;
             const dy = y - head.y;
             // Use a slightly larger threshold for spawning near worms
             if ((dx * dx + dy * dy) < Math.pow(WORM_SEGMENT_RADIUS * 10, 2)) {
                 return false; // Too close to a worm head
             }
            // If needed, iterate over more segments, but this adds cost
            // for (const seg of player.worm.segments) {
            //     const dx = x - seg.x;
            //     const dy = y - seg.y;
            //     if ((dx * dx + dy * dy) < MIN_FOOD_SPAWN_DISTANCE_SQ) {
            //         return false; // Too close to a worm segment
            //     }
            // }
        }
    }
    return true; // Position is clear
}

/**
 * Spawns food, trying to find clear positions.
 * @param {number} count - Number of food items to attempt spawning.
 */
function spawnFood(count) {
    let spawned = 0;
    for (let i = 0; i < count; i++) {
        if (food.length >= MAX_FOOD) break; // Don't exceed max food limit

        let spawnPos = null;
        let attempts = 0;
        const maxAttempts = 15; // Increased attempts to find a clear spot

        while (!spawnPos && attempts < maxAttempts) {
            attempts++;
            const potentialPos = getRandomSpawnPositionXY(FOOD_RADIUS * 4); // Increased margin
            if (isSpawnPositionClear(potentialPos.x, potentialPos.y)) {
                spawnPos = potentialPos;
            }
        }

        // If no clear spot found after attempts, use the last random spot as a fallback
        if (!spawnPos) {
             console.warn("Could not find clear spawn position for food after multiple attempts.");
            spawnPos = getRandomSpawnPositionXY(FOOD_RADIUS * 2); // Fallback: spawn anywhere with smaller margin
        }

        // Assign a random food type
        const foodType = Math.floor(Math.random() * FOOD_IMAGE_TYPES) + 1;

        food.push({
            id: `food-${nextFoodId++}`,
            x: spawnPos.x, y: spawnPos.y, z: WORLD_GROUND_Z,
            color: getRandomColor(), // Still include color, client can decide to use it or image
            radius: FOOD_RADIUS,
            type: foodType // <-- Added type identifier
        });

        spawned++;
    }
    // console.log(`Spawned ${spawned} food items. Total food: ${food.length}`); // Log food spawning
}


function createInitialWormSegments(startX, startY, length, angle) {
    const segments = [];
    for (let i = 0; i < length; i++) {
        segments.push({
            x: startX - Math.cos(angle) * i * WORM_SEGMENT_DISTANCE,
            y: startY - Math.sin(angle) * i * WORM_SEGMENT_DISTANCE,
            z: WORLD_GROUND_Z // Ensure segments have a Z coordinate
        });
    }
    return segments;
}

// --- Player & Bot Management Functions ---

/**
 * Initializes or resets a player's or bot's worm state.
 * @param {string} pId - The socket ID or bot ID.
 */
function resetPlayer(pId) {
    const player = players[pId];
    if (!player) return;

    // Find a clear spawn position for the new worm
    let spawnPos = null;
    let attempts = 0;
    const maxAttempts = 20; // Try multiple times to find a clear spot
    const spawnMargin = WORM_INITIAL_LENGTH * WORM_SEGMENT_DISTANCE + 100; // Ensure enough space

    while (!spawnPos && attempts < maxAttempts) {
        attempts++;
        const potentialPos = getRandomSpawnPositionXY(spawnMargin);
        // Check if the potential spawn area for the whole worm is clear
        let areaClear = true;
        const startAngle = Math.random() * Math.PI * 2;
        const tempSegments = createInitialWormSegments(potentialPos.x, potentialPos.y, WORM_INITIAL_LENGTH, startAngle);
        for(const seg of tempSegments) {
            if (!isSpawnPositionClear(seg.x, seg.y)) {
                areaClear = false;
                break;
            }
        }
        if (areaClear) {
             spawnPos = potentialPos;
        }
    }

    // Fallback if no perfectly clear area found
    if (!spawnPos) {
         console.warn(`Could not find perfectly clear spawn area for ${player.name}, using a random spot.`);
         spawnPos = getRandomSpawnPositionXY(spawnMargin); // Use a random spot as fallback
    }


    const startAngle = Math.random() * Math.PI * 2;
    const newColor = getRandomColor(); // Generate color

    player.worm = {
        segments: createInitialWormSegments(spawnPos.x, spawnPos.y, WORM_INITIAL_LENGTH, startAngle),
        angle: startAngle,
        targetAngle: startAngle, // Target angle starts same as current
        color: newColor,
        score: 0,
        isAlive: true,
        // Add server-side power-up state
        hasSpeedBoost: false,
        speedBoostEndTime: 0,
        isMagnetActive: false, // Server needs this for collision logic
        // Bot-specific state reset
        botState: player.isBot ? { targetFoodId: null, ticksUntilTargetUpdate: 0 } : undefined, // Store target food ID
    };
    console.log(`${player.isBot ? 'Bot' : 'Player'} ${player.name} (${pId}) spawned at (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)})`);
}

/**
 * Adds a new AI bot to the game.
 */
function addBot() {
    const botId = `bot_${nextBotId++}`; // Unique bot ID
    const botName = `${BOT_NAME_PREFIX} ${botId.substring(botId.length - 3)}`; // Bot name
    console.log(`Adding Bot: ${botName} (${botId})`);
    players[botId] = {
        id: botId,
        name: botName,
        isBot: true,
        worm: { // Initial placeholder, resetPlayer will fill it
             segments: [], angle: 0, targetAngle: 0, color: getRandomColor(), score: 0, isAlive: false,
             hasSpeedBoost: false, speedBoostEndTime: 0, isMagnetActive: false,
             botState: { targetFoodId: null, ticksUntilTargetUpdate: 0 }
        }
    };
    resetPlayer(botId); // Initialize the bot's state
}

/**
 * Removes a bot from the game.
 * @param {string} botId - The ID of the bot to remove.
 */
function removeBot(botId) {
     if (players[botId] && players[botId].isBot) {
         console.log(`Removing Bot: ${players[botId].name} (${botId})`);
         delete players[botId];
     }
}

/**
 * Kills a player or bot.
 * @param {string} pId - The ID of the player/bot.
 * @param {string} reason - Reason for death.
 */
function killPlayer(pId, reason) {
    const player = players[pId];
    // Ensure player exists and is currently alive before killing
    if (player && player.worm && player.worm.isAlive) {
        console.log(`${player.isBot ? 'Bot' : 'Player'} ${player.name} (${pId}) died: ${reason}. Score: ${player.worm.score}`);
        player.worm.isAlive = false; // Mark as dead

        // Drop food from segments
        if (player.worm.segments) {
             player.worm.segments.forEach((seg, index) => {
                // Drop food from segments at intervals with a chance
                if (index % FOOD_DROP_INTERVAL === 0 && Math.random() < FOOD_DROP_CHANCE) {
                    if (food.length < MAX_FOOD) {
                        // Drop food with a random type like regular spawned food
                        let foodType = Math.floor(Math.random() * FOOD_IMAGE_TYPES) + 1;
                        // Avoid using special type numbers for regular food if they overlap with 1-36
                        const specialFoodTypes = [FOOD_TYPE_POWER, FOOD_TYPE_ZOOM, FOOD_TYPE_MAGNET];
                         while(specialFoodTypes.includes(foodType)) {
                             foodType = Math.floor(Math.random() * FOOD_IMAGE_TYPES) + 1;
                         }

                        food.push({
                            id: `food-${nextFoodId++}`,
                            x: seg.x, y: seg.y, z: seg.z ?? WORLD_GROUND_Z,
                            color: player.worm.color, radius: FOOD_RADIUS,
                            type: foodType // <-- Added type identifier
                        });
                    }
                }
            });
        }


        // Notify human players of game over
        if (!player.isBot) {
            const socket = io.sockets.sockets.get(pId);
            if (socket) {
                socket.emit('gameOver', { score: player.worm.score });
                console.log(`Sent gameOver to player ${player.name}`);
            }
        } else {
             // Respawn bots automatically after a delay
             setTimeout(() => {
                 // Check if the bot still exists and is dead before respawning
                 if (players[pId] && !players[pId].worm.isAlive) {
                   resetPlayer(pId);
                   console.log(`Respawning bot ${player.name}`);
                 }
             }, 5000); // Respawn after 5 seconds
        }
    }
}

// --- Game Logic Functions ---

/**
 * Updates a single worm's position and angle based on its target angle.
 * @param {object} worm - The worm object.
 */
function updateWorm(worm) {
    // Ensure worm is alive and has segments before updating
    if (!worm.isAlive || !worm.segments || worm.segments.length === 0) return;

    const head = worm.segments[0];
    const targetAngle = worm.targetAngle;
    let currentAngle = worm.angle;

    // Calculate the shortest angle difference
    let angleDiff = targetAngle - currentAngle;
    while (angleDiff <= -Math.PI) angleDiff += Math.PI * 2;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

    // Update current angle, turning towards target angle
    if (Math.abs(angleDiff) > WORM_TURN_SPEED) {
        currentAngle += Math.sign(angleDiff) * WORM_TURN_SPEED;
    } else {
        currentAngle = targetAngle; // Snap to target if close enough
    }
    // Normalize angle to be within 0 to 2*PI
    worm.angle = (currentAngle + Math.PI * 2) % (Math.PI * 2);

    // Determine current speed (apply speed boost if active)
    const currentSpeed = (worm.hasSpeedBoost && Date.now() < worm.speedBoostEndTime) ? WORM_SPEED * SPEED_BOOST_FACTOR : WORM_SPEED;

    // Calculate new head position
    const newHeadX = head.x + Math.cos(worm.angle) * currentSpeed; // Use currentSpeed
    const newHeadY = head.y + Math.sin(worm.angle) * currentSpeed; // Use currentSpeed
    const newHeadZ = head.z ?? WORLD_GROUND_Z; // Ensure Z coordinate

    // Add new head segment at the front
    worm.segments.unshift({ x: newHeadX, y: newHeadY, z: newHeadZ });

    // Tail removal is handled after collision checks to allow for growth on eating
}

/**
 * AI Logic for a single bot.
 * @param {object} botPlayer - The bot player object.
 */
function updateBotAI(botPlayer) {
    // Ensure bot is alive and has worm data
    if (!botPlayer.worm?.isAlive) return;

    const botWorm = botPlayer.worm;
    const head = botWorm.segments[0];
    if (!head) return; // Should not happen if worm is alive

    let targetAngle = botWorm.angle; // Default to current angle

    // --- Basic Avoidance Logic ---
    let avoidAngle = null;
    // Look ahead position
    const lookAheadX = head.x + Math.cos(botWorm.angle) * BOT_AVOIDANCE_DISTANCE;
    const lookAheadY = head.y + Math.sin(botWorm.angle) * BOT_AVOIDANCE_DISTANCE;

    // 1. Boundary Avoidance: Check if look-ahead point is near world boundaries
    if (lookAheadX < BOT_BOUNDARY_AVOID_MARGIN || lookAheadX > WORLD_WIDTH - BOT_BOUNDARY_AVOID_MARGIN ||
        lookAheadY < BOT_BOUNDARY_AVOID_MARGIN || lookAheadY > WORLD_HEIGHT - BOT_BOUNDARY_AVOID_MARGIN)
    {
        // Turn towards the center of the world
        avoidAngle = Math.atan2(WORLD_HEIGHT / 2 - head.y, WORLD_WIDTH / 2 - head.x);
        // console.log(`${botPlayer.name} avoiding boundary.`);
    }

    // 2. Other Snake Avoidance: Check if look-ahead point is near other worm segments
    if (avoidAngle === null) { // Only check if not already avoiding boundary
        // Iterate over all players (including self, but skip self-collision check here)
        for (const pId in players) {
            const otherPlayer = players[pId];
            // Skip self and dead worms
            if (pId === botPlayer.id || !otherPlayer.worm?.isAlive) continue;

            // Iterate over other worm's segments (can be optimized by checking fewer segments)
            // For performance, maybe only check the head and a few segments near the head
            const segmentsToCheck = otherPlayer.worm.segments.slice(0, Math.min(otherPlayer.worm.segments.length, 20)); // Check first 20 segments
            for (const seg of segmentsToCheck) {
                const dx = lookAheadX - seg.x;
                const dy = lookAheadY - seg.y;
                const distSq = dx * dx + dy * dy;
                // Use a larger threshold for avoidance than collision
                if (distSq < Math.pow(WORM_SEGMENT_RADIUS * 4, 2)) { // Avoid if within 4x segment radius
                    // Impending collision detected - turn away
                    const angleToThreat = Math.atan2(seg.y - head.y, seg.x - head.x);
                    // Turn perpendicular to the threat, choosing left or right randomly
                    avoidAngle = angleToThreat + Math.PI / 2 * (Math.random() > 0.5 ? 1 : -1);
                    // console.log(`${botPlayer.name} avoiding ${otherPlayer.name}.`);
                   break; // Avoid first detected threat and stop checking this worm
                }
            }
            if (avoidAngle !== null) break; // Stop checking other players if avoidance is needed
        }
    }


    // --- Target Selection (if not avoiding) ---
    if (avoidAngle !== null) {
        // If avoidance is needed, set target angle to the calculated avoidance angle
        targetAngle = avoidAngle;
        botWorm.botState.targetFoodId = null; // Lose current food target when avoiding
        botWorm.botState.ticksUntilTargetUpdate = BOT_TARGET_UPDATE_INTERVAL_TICKS; // Re-evaluate target soon
    } else {
        // If not avoiding, find and steer towards the nearest food
        botWorm.botState.ticksUntilTargetUpdate--;

        // Check if the current target food still exists
        const currentTargetFood = food.find(f => f.id === botWorm.botState.targetFoodId);

        // Update target food periodically or if current target is gone
        if (botWorm.botState.ticksUntilTargetUpdate <= 0 || !currentTargetFood) {
            let closestFood = null;
            let minDistSq = Infinity;

            // Find the closest food item
            for (const f of food) {
                const dx = head.x - f.x;
                const dy = head.y - f.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    closestFood = f;
                }
            }

            // Set the new target food (store its ID)
            botWorm.botState.targetFoodId = closestFood ? closestFood.id : null;
            // Reset the target update timer
            botWorm.botState.ticksUntilTargetUpdate = BOT_TARGET_UPDATE_INTERVAL_TICKS;
            // console.log(`${botPlayer.name} updated target food: ${botWorm.botState.targetFoodId}`);
        }

        // Steer towards the target food if one exists
        if (botWorm.botState.targetFoodId) {
             const targetFood = food.find(f => f.id === botWorm.botState.targetFoodId);
             if (targetFood) {
                 targetAngle = Math.atan2(targetFood.y - head.y, targetFood.x - head.x);
             } else {
                 // Target food disappeared before bot reached it, clear target
                 botWorm.botState.targetFoodId = null;
                 botWorm.botState.ticksUntilTargetUpdate = 0; // Find new target next tick
             }
        } else {
            // No food available? Wander aimlessly with a slight random turn
             if (Math.random() < BOT_RANDOM_TURN_CHANCE) { // Occasionally change direction
                 targetAngle += (Math.random() - 0.5) * Math.PI / 8; // Small random turn
             }
        }
    }

    // Set the final target angle for the worm update logic
    // Normalize the target angle
    botWorm.targetAngle = (targetAngle + Math.PI * 2) % (Math.PI * 2);
}


/**
 * Checks for collisions between worms and food, and self/other worm collisions.
 */
function checkCollisions() {
    const playerIds = Object.keys(players);
    eatenFoodThisTick = []; // Clear eaten food list at the start of the tick

    // Create a list of only living worms for efficient collision checks
    const livingWorms = playerIds
        .map(id => players[id])
        .filter(player => player.worm?.isAlive);

    // --- Food Collision ---
    // Iterate through living worms and check for food collision with their head
    for (const player of livingWorms) {
        const worm = player.worm;
        const head = worm.segments[0];
        if (!head) continue; // Should not happen for living worms

        let ateFoodThisTickFlag = false; // Flag to check if *any* food was eaten by this worm this tick

        // Iterate through food items (backwards for safe removal)
        for (let j = food.length - 1; j >= 0; j--) {
            const f = food[j];
            const dx = head.x - f.x;
            const dy = head.y - f.y;
            const distSq = dx * dx + dy * dy;

            // Calculate effective collision radius (larger if magnet is active for this player)
            const effectiveCollisionRadius = worm.isMagnetActive ?
                                             WORM_SEGMENT_RADIUS + FOOD_RADIUS * MAGNET_RADIUS_MULTIPLIER :
                                             WORM_SEGMENT_RADIUS + FOOD_RADIUS;
            const effectiveCollisionThresholdSq = Math.pow(effectiveCollisionRadius, 2);


            if (distSq < effectiveCollisionThresholdSq) {
                // Food eaten!
                const eatenFoodItem = food.splice(j, 1)[0]; // Remove and get the eaten food
                eatenFoodThisTick.push({ id: eatenFoodItem.id, eaterId: player.id, type: eatenFoodItem.type }); // Record eaten food with type

                worm.score += FOOD_SCORE; // Increase score
                ateFoodThisTickFlag = true; // Set flag that food was eaten
                spawnFood(1); // Spawn one new food item

                // Server-side power-up activation (for speed boost and magnet duration)
                if (eatenFoodItem.type === FOOD_TYPE_POWER) {
                    worm.hasSpeedBoost = true;
                    worm.speedBoostEndTime = Date.now() + POWER_UP_DURATION_MS;
                    // console.log(`${player.name} got speed boost!`);
                } else if (eatenFoodItem.type === FOOD_TYPE_MAGNET) {
                     worm.isMagnetActive = true;
                     // Server-side magnet duration
                      setTimeout(() => {
                         // Check if the worm still exists and has the magnet active before turning it off
                         if (player.worm && player.worm.isMagnetActive) {
                             player.worm.isMagnetActive = false;
                             // console.log(`${player.name}'s magnet expired.`);
                         }
                         }, POWER_UP_DURATION_MS);
                      // console.log(`${player.name} got magnet!`);
                }
                 // Zoom is client-side only effect triggered by food type

                // If it was a bot's target, clear the target
                if (player.isBot && player.worm.botState.targetFoodId === eatenFoodItem.id) {
                    player.worm.botState.targetFoodId = null; // Clear target food ID
                    player.worm.botState.ticksUntilTargetUpdate = 0; // Find new target next tick
                    // console.log(`${player.name} ate target food.`);
                }

                // If magnet is active, continue checking for other food in range this tick
                if (!worm.isMagnetActive) {
                     break; // Only eat one food per tick if not magnet boosted
                }
            }
        }

        // Worm Movement/Growth Logic - Tail removal only if NO food was eaten by THIS worm this tick
        // This allows the worm to grow when it eats.
        if (!ateFoodThisTickFlag && worm.segments.length > WORM_INITIAL_LENGTH) {
            worm.segments.pop(); // Remove the last segment (tail)
        }
    }


    // --- Worm-to-Worm Collision (Self and Other) ---
    // This is the most computationally expensive part.
    // Current complexity is roughly O(N^2 * M) where N is living worms and M is average segments.
    // Can be optimized using spatial partitioning (e.g., Quadtree or Grid).

    // Iterate through each living worm
    for (let i = 0; i < livingWorms.length; i++) {
        const player = livingWorms[i];
        const worm = player.worm;
        const head = worm.segments[0];
        if (!head) continue; // Should not happen

        // 1. World Boundary Collision
        if (head.x < 0 || head.x > WORLD_WIDTH || head.y < 0 || head.y > WORLD_HEIGHT) {
            killPlayer(player.id, "hit world boundary");
            // Mark as dead immediately so it's skipped in subsequent checks in this loop iteration
            worm.isAlive = false;
            continue; // Player is dead, skip further collision checks for them
        }

        // Check if player died from boundary collision before proceeding
        if (!worm.isAlive) continue;

        // 2. Self Collision
        // Check head collision with its own segments, starting from SELF_COLLISION_START_INDEX
        for (let k = SELF_COLLISION_START_INDEX; k < worm.segments.length; k++) {
            const seg = worm.segments[k];
            const dx = head.x - seg.x;
            const dy = head.y - seg.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < SELF_COLLISION_THRESHOLD_SQUARED) {
                killPlayer(player.id, "collided with self");
                 // Mark as dead immediately
                worm.isAlive = false;
                break; // No need to check further self segments
            }
        }

        // Check if player died from self-collision before proceeding
        if (!worm.isAlive) continue;

        // 3. Other Player/Bot Collision
        // Check head collision with segments of other living worms
        for (let j = 0; j < livingWorms.length; j++) {
            const otherPlayer = livingWorms[j];
            // Skip self and worms that just died from a previous collision check in this tick
            if (player.id === otherPlayer.id || !otherPlayer.worm.isAlive) continue;

            const otherWorm = otherPlayer.worm;
            // Iterate over other worm's segments (can be optimized)
            // For performance, maybe only check segments near the player's head
            // Or use a spatial partitioning structure.
            // Simple optimization: only check a subset of segments if the other worm is very long.
             const segmentsToCheck = otherWorm.segments; // Check all segments for accuracy

            for (let k = 0; k < segmentsToCheck.length; k++) {
                const seg = segmentsToCheck[k];
                const dx = head.x - seg.x;
                const dy = head.y - seg.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < OTHER_COLLISION_THRESHOLD_SQUARED) {
                    killPlayer(player.id, `collided with ${otherPlayer.name}`);
                    // Mark as dead immediately
                    worm.isAlive = false;
                    break; // Collision detected, stop checking this other player's segments
                }
            }
            // If the current player died from collision with this other player, stop checking against other players
            if (!worm.isAlive) break;
        }
    }
}

/**
 * Generates the leaderboard data.
 * @returns {Array<LeaderboardEntry>} Sorted list of leaderboard entries.
 */
function getLeaderboard() {
    // Map player objects to leaderboard entries and sort by score
    return Object.values(players)
        .filter(player => player.worm) // Only include players with worm data
        .map(p => ({
            id: p.id,
            name: p.name || `${p.isBot ? 'Bot' : 'Worm'} ${p.id.substring(0, 4)}`, // Use name if available
            score: p.worm.score ?? 0, // Use worm's score
             color: p.worm.color // Include color
        }))
        .sort((a, b) => b.score - a.score) // Sort descending by score
        .slice(0, 10); // Take top 10
}

/**
 * Prepares the game state object to be sent to clients.
 * @returns {object} The game state snapshot.
 */
function prepareGameState() {
    const wormsForClient = {};
    // Iterate over all players
    Object.values(players).forEach(p => {
        // Only include players with worm data in the state
        if (p.worm) {
            wormsForClient[p.id] = {
                id: p.id,
                name: p.name, // Send name for potential display
                isBot: p.isBot, // Let client know if it's a bot
                // Send a copy of segments to avoid modifying the original array during serialization
                segments: p.worm.segments.map(s => ({ x: s.x, y: s.y, z: s.z ?? WORLD_GROUND_Z })),
                color: p.worm.color,
                angle: p.worm.angle,
                score: p.worm.score,
                isGameOver: !p.worm.isAlive, // Indicate if this specific worm is dead
                // Send relevant state for client-side effects (e.g., visual cues)
                hasSpeedBoost: p.worm.hasSpeedBoost || false,
                isMagnetActive: p.worm.isMagnetActive || false,
                // isZoomActive is purely client-side, triggered by food type
            };
        }
    });
    // Ensure the 'type' property is included in the food sent to the client
    const foodForClient = food.map(f => ({
        id: f.id,
        x: f.x,
        y: f.y,
        z: f.z ?? WORLD_GROUND_Z, // Ensure Z is included
        color: f.color,
        radius: f.radius,
        type: f.type // <-- Include the type here
    }));

    return {
        worms: wormsForClient,
        food: foodForClient,
        leaderboard: getLeaderboard(), // Include leaderboard
        eatenFood: eatenFoodThisTick // <-- Include eaten food with type for client power-up activation
    };
}

// --- Main Game Loop ---
function gameLoop() {
    // 0. Bot Management (Add/Remove based on player count)
    const humanPlayerCount = Object.values(players).filter(p => !p.isBot).length;
    const currentBotCount = Object.values(players).filter(p => p.isBot).length;

    // Maintain a target number of bots relative to human players, or a minimum
    const targetBots = Math.max(BOT_COUNT, humanPlayerCount * 2); // Example: at least BOT_COUNT, or double human players

    if (currentBotCount < targetBots) {
        addBot();
    } else if (currentBotCount > targetBots && currentBotCount > 0) {
        // Remove excess bots (remove a random bot)
        const botIds = Object.keys(players).filter(id => players[id].isBot);
        if (botIds.length > targetBots) {
             const botToRemoveId = botIds[Math.floor(Math.random() * botIds.length)];
             removeBot(botToRemoveId);
        }
    }

    // 1. Update Bot AI (Targeting, Avoidance) -> Sets bot's targetAngle
    Object.values(players).forEach(player => {
        if (player.isBot && player.worm?.isAlive) {
            updateBotAI(player);
        }
    });

    // 2. Update positions (XY) and angles of all living worms based on targetAngle
    Object.values(players).forEach(player => {
        if (player.worm?.isAlive) {
            updateWorm(player.worm);
        }
    });

    // 3. Check for collisions (XY), handle eating, death, etc.
    checkCollisions(); // This populates eatenFoodThisTick

    // 4. Prepare the state snapshot to send to clients
    const gameState = prepareGameState();

    // 5. Emit the game state to all connected clients
    io.emit('gameState', gameState);
}

// --- Socket.IO Event Handlers ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Player Initialization
    const playerName = `Worm_${socket.id.substring(0, 4)}`;
    players[socket.id] = {
        id: socket.id, name: playerName, isBot: false,
        worm: { segments: [], angle: 0, targetAngle: 0, color: getRandomColor(), score: 0, isAlive: false } // Initial placeholder
    };
    resetPlayer(socket.id); // Initialize player's worm state

    // Send welcome data to the new client
    socket.emit('welcome', {
        playerId: socket.id,
        worldSize: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    });

    // Handle player input (angle and speed boost status)
    socket.on('playerInput', (data) => {
        const player = players[socket.id];
        // Validate input and ensure player is alive before applying input
        if (player?.worm?.isAlive && data && typeof data.angle === 'number' && isFinite(data.angle)) {
            // Update the player's target angle based on client input
            player.worm.targetAngle = data.angle;
            // Client sends if they are *trying* to speed boost (e.g., holding a button)
            // Server decides if the boost is actually active based on power-up state/duration.
            // The server doesn't just mirror the client's isSpeedBoosting flag here.
            // If you add a boost button client-side, you'd process that input here.
            // For now, speed boost is solely tied to the power-up duration managed by the server.
        }
    });

    // Handle player respawn request from client
    socket.on('respawn', () => {
        const player = players[socket.id];
        // Only respawn if the player exists and is currently dead
        if (player && !player.worm.isAlive) {
            resetPlayer(socket.id); // Reset player's state (spawns new worm)
            console.log(`Player ${player.name} requested respawn.`);
            // Server will include the respawned worm in the next gameState update
        }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        const player = players[socket.id];
        const name = player ? player.name : `User ${socket.id.substring(0,4)}`;
        console.log(`${name} disconnected. Reason: ${reason}`);
        // Optionally kill the player's worm on disconnect
        // killPlayer(socket.id, "disconnected"); // This would drop food etc.
        // Or simply remove the player entry
        delete players[socket.id]; // Remove player from state
    });

    // Handle name change request from client
     socket.on('setPlayerName', (name) => {
         const player = players[socket.id];
         if (player && typeof name === 'string') {
             const sanitizedName = name.trim().substring(0, 16); // Limit name length
             if (sanitizedName) {
                  player.name = sanitizedName; // Update player's name
                  console.log(`Player ${socket.id} set name to ${sanitizedName}`);
             }
         }
     });
});

// --- Server Routing ---
// Serve the static React build files
app.get("/favicon.ico", (req, res) => res.sendStatus(204));
app.get("*", (req, res) => {
    const indexPath = path.join(reactBuildPath, "index.html");
    res.sendFile(indexPath, (err) => {
        if (err) {
            console.error("Error sending index.html:", err);
            if (!res.headersSent) {
                res.status(500).send("Error loading the game.");
            }
        }
    });
});

// --- Start Server and Game ---

spawnFood(MAX_FOOD / 2); // Start with half the max food initially
// Initialize bots
for(let i = 0; i < BOT_COUNT; i++) { addBot(); }
// Start game loop interval
setInterval(gameLoop, TICK_RATE_MS);
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`Game world size: ${WORLD_WIDTH}x${WORLD_HEIGHT}`);
    console.log(`Target Bot Count: ${BOT_COUNT}`);
    console.log(`Tick rate: ~${(1000 / TICK_RATE_MS).toFixed(1)} FPS`);
});
