import { readWorkerConfig, stripeTestConfig } from '../packages/core/config.js';
import { StripeTestClient, STRIPE_API_VERSION } from '../packages/capabilities/stripe/client.js';

// Read-only account preflight. It never creates a PaymentIntent or a token.
try {
  const options = stripeTestConfig(readWorkerConfig());
  if (!options) throw new Error('Stripe test integration is disabled; configure the test account first');
  const client = new StripeTestClient(options), receipt = await client.verifyAccount(new AbortController().signal);
  process.stdout.write(JSON.stringify({ accountVerified: true, paymentExecutionVerified: false, accountId: options.accountId, merchantId: options.merchantId, mode: 'test', apiVersion: STRIPE_API_VERSION, receipt }, null, 2) + '\n');
} catch (error) {
  // Configuration validation may include values; never print a raw exception.
  process.stderr.write('Stripe test account verification failed. Check the explicit sandbox configuration, private test key, account ID and API permissions. No payment was attempted.\n');
  process.exitCode = 1;
}
