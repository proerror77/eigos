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
} as const;
