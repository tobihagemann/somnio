#!/usr/bin/env node
import { runServer } from './bootstrap/runServer.ts';

runServer(process.env).catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
