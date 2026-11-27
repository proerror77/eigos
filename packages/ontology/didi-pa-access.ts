import { reconcileImmediateRideAction, reconcileImmediateRideFunction } from './didi-immediate-ride.js';

/** Explicit DiDi pilot grants. PA quotation and tracking are read-only at the supplier. */
export const didiPAAccountResources = new Set([
  'Eigos/source/Didi', 'Eigos/source/Amap', 'Eigos/source/PALocation',
  ...['Place', 'Route', 'RideRequest', 'RideEstimate', 'SourceReceipt', 'PersonalPlace',
    'PersonalPlaceVersion', 'DidiRideOrder', 'DidiRideWatch', 'DidiRideOrderStateLog',
    'DidiRideWatchStateLog'].map(name => 'Eigos/object/' + name),
  ...['searchPlaces', 'locationsReady', 'resolveRideLocations', 'estimateLocations', 'prepareRideInquiry',
    'readRideEstimates', 'resolveRidePickup', 'resolveTaskLocation', 'prepareRideInquiryWithEndpoints',
    'readInteractiveRideEstimate', 'savePersonalPlace', 'readDidiRideOrder', 'startDidiRideWatch',
    'checkDidiRideWatch', 'stopDidiRideWatch', 'readDidiRideWatch', 'readDidiDriverPosition']
    .map(name => 'Eigos/function/' + name),
  ...['EstimateRide', 'EstimateRideWithEndpoints', 'SavePersonalPlace', 'StartDidiRideWatch',
    'CheckDidiRideWatch', 'StopDidiRideWatch'].map(name => 'Eigos/action/' + name),
]);

export const didiPAOrderAccountResources = new Set([
  ...didiPAAccountResources,
  'Eigos/object/DidiImmediateRide',
  'Eigos/object/ActionConfirmation',
  'Eigos/object/ActionConfirmationStateLog',
  'Eigos/object/DidiImmediateRideStateLog',
  'Eigos/function/' + reconcileImmediateRideFunction,
  'Eigos/action/' + reconcileImmediateRideAction,
  'Eigos/function/bookDidiImmediateRide',
  'Eigos/function/bookDidiRideWithEndpoints',
  'Eigos/function/readDidiImmediateRide',
  'Eigos/action/BookDidiImmediateRide',
  'Eigos/action/BookDidiRideWithEndpoints',
]);
