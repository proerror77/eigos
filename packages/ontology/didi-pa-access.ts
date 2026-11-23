/** Explicit DiDi pilot grants. The account publication sync does not add them. */
export const didiPAAccountResources = new Set([
  'Eigos/source/Didi', 'Eigos/source/Amap', 'Eigos/source/PALocation',
  ...['Place', 'Route', 'RideRequest', 'RideEstimate', 'SourceReceipt',
    'DidiImmediateRide', 'DidiRideOrder', 'PersonalPlace', 'PersonalPlaceVersion', 'DidiRideWatch', 'ActionConfirmation', 'DidiImmediateRideStateLog', 'DidiRideOrderStateLog',
    'DidiRideWatchStateLog', 'ActionConfirmationStateLog'].map(name => 'Eigos/object/' + name),
  ...['searchPlaces', 'locationsReady', 'resolveRideLocations', 'estimateLocations', 'prepareRideInquiry',
    'readRideEstimates', 'bookDidiImmediateRide', 'readDidiImmediateRide', 'resolveRidePickup', 'resolveTaskLocation',
    'prepareRideInquiryWithEndpoints', 'readInteractiveRideEstimate', 'bookDidiRideWithEndpoints', 'savePersonalPlace', 'readDidiRideOrder', 'startDidiRideWatch',
    'checkDidiRideWatch', 'stopDidiRideWatch', 'readDidiRideWatch', 'readDidiDriverPosition'].map(name => 'Eigos/function/' + name),
  ...['EstimateRide', 'BookDidiImmediateRide', 'EstimateRideWithEndpoints', 'BookDidiRideWithEndpoints',
    'SavePersonalPlace', 'StartDidiRideWatch', 'CheckDidiRideWatch', 'StopDidiRideWatch'].map(name => 'Eigos/action/' + name),
]);
