import type {BridgeConfig} from '../types.js';
import {bridgeHome} from '../shared/local-paths.js';
import {loadBridgeConfig} from './configuration.js';
export function loadConfig(home = bridgeHome()): BridgeConfig {
  return loadBridgeConfig(home);
}
