export const ConnectionStatus = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed',
    DISCONNECTED: 'disconnected',
    RECONNECTING: 'reconnecting',
};

export const PlayerState = {
    ALIVE: 'alive',
    EATING: 'eating',
    DEAD: 'dead',
    FADING: 'fading',
};

export const GameConstants = {
    WORM_SEGMENT_RADIUS: 10,
    WORM_HEAD_RADIUS: 12, // WORM_SEGMENT_RADIUS + 2
    FOOD_RADIUS: 6,
    WORLD_WIDTH: 3000,
    WORLD_HEIGHT: 3000,
    WORM_WIGGLE_SPEED: 0.3,
    WORM_WIGGLE_MAGNITUDE: 0.5,
    WORM_BLINK_INTERVAL: 3000,
    JOYSTICK_SIZE: 120,
    JOYSTICK_STICK_SIZE: 50,
    JOYSTICK_DEADZONE: 0.1,
    PREDICTIVE_PATH_LENGTH: 50,
    COMBO_TIMEOUT: 2000,
    EAT_ANIMATION_DURATION: 150,
    DEATH_ANIMATION_DURATION: 500,
    SERVER_URL: 'http://localhost:4000/',
    // Add other constants...
};
