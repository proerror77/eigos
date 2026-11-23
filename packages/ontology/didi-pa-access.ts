/** Explicit DiDi pilot grants. The account publication sync does not add them. */
export const didiPAAccountResources = new Set([
  'Eigos/source/Didi', 'Eigos/source/Amap', 'Eigos/source/PALocation',
  ...['Place', 'Route', 'RideRequest', 'RideEstimate', 'SourceReceipt',
    'DidiImmediateRide', 'DidiRideOrder', 'PersonalPlace', 'PersonalPlaceVersion'].map(name => 'Eigos/object/' + name),
  ...['searchPlaces', 'locationsReady', 'resolveRideLocations', 'estimateLocations', 'prepareRideInquiry',
    'readRideEstimates', 'bookDidiImmediateRide', 'readDidiImmediateRide', 'resolveRidePickup', 'resolveTaskLocation',
    'prepareRideInquiryWithEndpoints', 'readInteractiveRideEstimate', 'bookDidiRideWithEndpoints', 'savePersonalPlace'].map(name => 'Eigos/function/' + name),
  ...['EstimateRide', 'BookDidiImmediateRide', 'EstimateRideWithEndpoints', 'BookDidiRideWithEndpoints',
    'SavePersonalPlace'].map(name => 'Eigos/action/' + name),
]);
