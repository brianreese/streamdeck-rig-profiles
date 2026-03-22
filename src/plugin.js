// plugin.js — Stream Deck plugin entry point.
//
// Startup sequence:
//   1. ensureConfig() — copies profiles.yaml template on first run, creates shared state dir
//   2. configLoader.init() — parses and validates profiles.yaml, starts file watcher
//   3. streamDeck.connect() — connects to the Stream Deck software WebSocket
//
// Action handlers (keyDown, keyUp, willAppear, etc.) are registered on the
// streamDeck instance before connect() is called.

import streamDeck from '@elgato/streamdeck';
import { ensureConfig } from './setup.js';
import { init as initConfig } from './configLoader.js';

// Step 1: first-run setup
ensureConfig();

// Step 2: load and watch config
await initConfig();

// Step 3: connect to Stream Deck
// TODO: register action handlers here before connect()
streamDeck.connect();
