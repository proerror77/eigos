import { commerceConnectionsFromConfig, commerceReadiness } from '../packages/capabilities/payment-commerce/connection.js';

// Offline only. Never starts a provider runtime or requests an order/payment.
console.log(JSON.stringify({ checks: commerceReadiness(commerceConnectionsFromConfig(process.env)), sourceContacted: false }, null, 2));
