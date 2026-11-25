/**
 * npm run gads:check -- 724-800-0350
 * Checks the Google Ads connection step by step and changes nothing in Google Ads.
 */
import { connect, listClientAccounts, parseArgs, run, say } from './gads-common.js';

await run(async () => {
  say.title('Campaign Ops: Google Ads connection check');
  const conn = await connect(parseArgs(process.argv.slice(2)));

  const clients = await listClientAccounts(conn);
  const ads = clients.filter((c) => !c.manager);
  if (ads.length === 0) {
    say.info('There are no ad accounts inside it yet. Setup will create one called "Demo Apartments".');
  } else {
    say.info(`Ad accounts inside it: ${ads.length}`);
    for (const c of ads) say.line(`${c.id}  ${c.name}  (${c.testAccount ? 'test' : 'REAL'}, ${c.status.toLowerCase()})`);
  }

  console.log('');
  console.log('All checks passed. Nothing was changed in Google Ads.');
  console.log('Next step: npm run gads:setup');
});
