/** Explicit DiDi pilot grants. The account publication sync does not add them. */
export const didiPAAccountResources = new Set([
  'Eigos/source/Didi',
  ...['Place', 'Route', 'RideRequest', 'RideEstimate', 'SourceReceipt',
    'DidiImmediateRide', 'DidiRideOrder'].map(name => 'Eigos/object/' + name),
  ...['searchPlaces', 'locationsReady', 'resolveRideLocations', 'estimateLocations', 'prepareRideInquiry',
    'readRideEstimates', 'bookDidiImmediateRide', 'readDidiImmediateRide'].map(name => 'Eigos/function/' + name),
  'Eigos/action/EstimateRide', 'Eigos/action/BookDidiImmediateRide',
]);
