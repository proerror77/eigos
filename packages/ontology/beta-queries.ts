// The account policy is fixed independently of the published business catalogue.
export const betaQueries = {
  sources: ['Amap', 'Fliggy'],
  objects: ['FliggyFlightOffer', 'FliggyFlightSearch', 'FliggyHotelOffer', 'FliggyHotelSearch',
    'RestaurantSearchResult', 'RestaurantSourceVenue'],
  functions: ['readFliggyFlights', 'readFliggyHotels', 'readServiceSearch', 'readServiceSearchPages',
    'readWeather', 'searchMapPlaces', 'readMapPlace', 'readRestaurantSearch'],
  actions: [
    ['SearchFliggyFlights', 'searchFliggyFlights'],
    ['SearchFliggyHotels', 'searchFliggyHotels'],
    ['FindRestaurants', 'findRestaurants'],
  ],
  instructions: 'This Beta account can search FlyAI flights and hotels and query Amap weather, places and restaurants. Use only these queries with the dates and places provided. Return supplier evidence through the published query Functions.',
} as const;
