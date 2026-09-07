#!/usr/bin/env node
// Runs the plugin from TypeScript source, for development.
import { execute } from '@oclif/core';

await execute({ development: true, dir: import.meta.url });
