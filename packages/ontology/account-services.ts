// Platform-funded queries retain their read-only Action binding.
export const betaQueryActions = [
  ['SearchFliggyFlights', 'searchFliggyFlights'],
  ['SearchFliggyHotels', 'searchFliggyHotels'],
  ['FindRestaurants', 'findRestaurants'],
] as const;

// Publishing these resources does not assign them to the default account group.
export const operatorResources = new Set([
  'Eigos/object/OntologyScenario',
  'Eigos/action/RegisterGeometry', 'Eigos/action/AnnotateGeometry', 'Eigos/function/annotateGeometry',
  'Eigos/source/DidiPetRideSandbox', 'Eigos/action/PreparePetRideHandoff', 'Eigos/action/RecordPetRideReceipt',
  'Eigos/function/preparePetRideHandoff', 'Eigos/function/recordPetRideReceipt',
]);
