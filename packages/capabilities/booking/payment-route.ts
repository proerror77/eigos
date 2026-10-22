import type { AgentProgramContext } from '../../core/agent-program.js';
import { DomainError } from '../../core/domain.js';
import { digest } from '../../core/delegation.js';
import { readBookingObservation } from '../../ontology/booking-functions.js';
import { bookingDataSchema, bookingPaymentDataSchema } from '../../ontology/booking.js';
import type { PAPaymentState } from './pa-payment.js';

/** Current source proof for the original component, separate from PA wallet availability. */
export function assertPaymentRouteReadback(ctx: AgentProgramContext, payment: PAPaymentState) {
      if (ctx.request.requirements.some(r => r.kind === 'deadline' && r.strength === 'hard' && (!r.role || r.role === 'completion') && Date.parse(r.expected.at) <= Date.now())) throw new DomainError('CONFLICT', 'The requested booking completion deadline expired before payment route selection');
      const latest = (type: string) => ctx.state.observations.filter(ref => ref.type === type).at(-1);
      const bookingRef = latest('BookingObservation'), paymentRef = latest('BookingPaymentObservation');
      if (!bookingRef || !paymentRef) throw new DomainError('CONFLICT', 'Read the original provider booking and payment before selecting a route');
      const booked = readBookingObservation(ctx.graph, ctx.owner, bookingRef), paid = readBookingObservation(ctx.graph, ctx.owner, paymentRef);
      const b = bookingDataSchema.parse(booked.payload.data), money = bookingPaymentDataSchema.parse(paid.payload.data);
      const terms = payment.request.terms;
      if ([booked, paid].some(s => s.receipt.requestId !== ctx.request.id || s.receipt.requestRevision !== payment.request.requestRevision || s.configurationDigest !== payment.request.configurationDigest || s.receipt.readbackSequence !== payment.readbackSequence)) throw new DomainError('CONFLICT', 'Payment route requires the current owned provider readback');
      if (b.providerId !== terms.providerId || b.holdExpiresAt !== terms.expiresAt || digest(b.checkout) !== digest(terms.checkout) || digest(b.paymentHandler) !== digest(terms.handler) || digest(b.offer.total) !== digest(terms.amount)) throw new DomainError('CONFLICT', 'Payment routes must retain the original independently read provider terms');
      if (booked.receipt.action !== 'ReadProviderBooking' || paid.receipt.action !== 'ReadProviderPayment' || b.bookingId !== terms.bookingId || b.termsDigest !== terms.bookingTermsDigest || b.state !== 'awaiting_payment' || money.bookingId !== terms.bookingId || money.bookingTermsDigest !== terms.bookingTermsDigest || money.state !== 'unpaid' || money.paidAmount.minor !== '0' || money.paymentId || money.capturedAt) throw new DomainError('CONFLICT', 'The original provider booking must still be unpaid; reconcile instead of switching payment routes');
}
