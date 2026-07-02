#!/usr/bin/env node
import { createProgram } from '../src/index.js';
import { handleError } from '../src/lib/error.js';

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch(handleError);
