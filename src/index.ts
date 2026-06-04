#!/usr/bin/env node
/** 入口 */

import { cac } from 'cac';
import { _ } from './i18n.js';
import { main } from './main.js';

const cli = cac('lportal');

cli
  .command('', _('Start Local Portal service'))
  .option('-p, --port <number>', 'Service port', { default: 14554 })
  .option('--auto-copy', 'Auto copy mode', { default: true })
  .option('--no-auto-copy', 'Disable auto copy mode')
  .option('--max-history <number>', 'Max history entries', { default: 10 })
  .option('-c, --code <string>', 'Custom 4-digit pairing code')
  .option('--zh', 'Force Chinese language')
  .option('--en', 'Force English language')
  .action(async (options) => {
    await main({
      port: Number(options.port),
      autoCopy: options.autoCopy,
      maxHistory: Number(options.maxHistory),
      code: options.code,
      zh: options.zh,
      en: options.en,
    });
  });

cli.help();
cli.parse();
