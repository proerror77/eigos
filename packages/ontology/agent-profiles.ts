import type { OntologyDocument } from './schema.js';

export const sandboxAgentCapability = { kind: 'agent-capability', name: 'sandbox' } as const;

// Releases before the capability tag use these same published API names.
export const historicalAgentSandboxResources = {
  actions: ['CreateStripeSandboxOrder', 'RecoverStripeSandboxOrder', 'PrepareStripeLinkPayment',
    'HandoffStripeLinkPayment', 'RefreshStripeLinkPayment', 'PrepareDiningTestReservation',
    'PrepareDiningMiniProgramTestReservation', 'SubmitDiningTestReservation', 'RefreshDiningTestReservation'],
  objects: ['StripeSandboxOrder', 'StripeLinkPayment', 'DiningReservation'],
};
export type AgentProfile = NonNullable<OntologyDocument['agentProfiles']>[number];

/** Tool discovery profiles shipped in the EIGOS definition. Terms only preload definitions. */
export const businessAgentProfiles: AgentProfile[] = [
  {
    apiName: 'RideQuote',
    terms: ['打车', '滴滴', '估价', '车费', '车价', '询价', '出租车', 'didi', 'taxi', 'ride quote', 'fare only', 'fare estimate',
      '叫车', '叫个车', '叫辆车', '打个车', '打辆车', '网约车', '专车', '快车', '用车'],
    objects: ['RideRequest', 'Route', 'Place', 'RideEstimate'],
    interfaces: ['RideInquiry', 'RideInquiryWithPlaceClues', 'RideEstimatable'],
    actions: ['EstimateRide', 'EstimateRideWithPlaceClues'],
    functions: ['readRideEstimates', 'readInteractiveRideEstimate'],
    instructions: [
      { action: 'EstimateRide', function: 'readRideEstimates', text: 'When the user provides the city, pickup and destination for a fare-only inquiry, use complete_with_action with RideInquiry.estimate on RideRequest and readRideEstimates (resultParameter: request). Include serviceClass only for a specified vehicle class.' },
      { action: 'EstimateRideWithPlaceClues', function: 'readInteractiveRideEstimate', text: 'Use RideInquiryWithPlaceClues.estimate on RideRequest with readInteractiveRideEstimate when the user also requests driving time, provides landmark clues, or the named ride inquiry cannot be used. Pass a given pickup or itinerary point as origin. With authorized device location, omit origin to ask the original PA for fresh phone location and verify its coordinate system. Omit a missing destination so the Action asks for it. Pass only a city established by the user. Keep nearby landmarks separate and preserve ambiguous names for the Action to resolve.' },
    ],
  },
  {
    apiName: 'SchedulePlanning',
    terms: ['日历', '排程', '行程', '安排', '时段', 'schedule', 'calendar', 'planning', 'itinerary', 'time slot',
      '日程', '有空吗', '有没有空', '什么时候有空', '哪天有空', '空闲时间', '有没有时间'],
    objects: ['SchedulePlan', 'ScheduledActivity', 'ScheduleResource', 'CalendarAvailability', 'SchedulePlanStateLog'],
    interfaces: ['SchedulablePlan'],
    actions: ['PrepareSchedulePlan', 'SaveScheduleActivity', 'StageScheduleRecommendation'],
    functions: ['findScheduleSlots', 'readSchedulePlan', 'validateSchedule', 'recommendSchedule'],
    instructions: [
      { action: 'PrepareSchedulePlan', text: 'Obtain calendar availability through the published planning capability. It requests authorized data from the original PA and resumes this same task. For replanning an existing SchedulePlan, create a Scenario first, call its live PrepareSchedulePlan Action with input.plan and input.scenarioId, then read and edit that same Scenario. Keep proposed fields staged and validate the returned plan. The PA explicitly applies a reviewed merge.' },
    ],
  },
  {
    apiName: 'TravelOffers',
    terms: ['酒店', '机票', '航班', 'hotel', 'flight', 'travel offer', 'rollinggo', 'fliggy', '飞猪',
      '住哪', '住宿', '订房', '宾馆', '民宿', '飞机'],
    objects: ['TravelOfferSearch'],
    interfaces: ['TravelOfferInquiry', 'FlightSearch', 'HotelSearch', 'HotelOffer'],
    actions: ['SearchTravelOffers', 'SearchRollingGoHotels', 'PrepareFliggyHotelBooking', 'PrepareFliggyFlightBooking'],
    functions: ['readTravelOfferSearch', 'readServiceSearchPages', 'readServiceSearch', 'readServiceOffering'],
    instructions: [
      { action: 'SearchTravelOffers', function: 'readTravelOfferSearch', text: 'Use the TravelOfferInquiry.search Interface Action on TravelOfferSearch so the supplier reads run concurrently. Use the same user criteria for participating suppliers. For direct results use complete_with_action and bind readTravelOfferSearch to search. For a coordinated itinerary search before opening a Scenario. Preserve supplier outcomes, access mode and display prices.' },
      { action: 'PrepareFliggyHotelBooking', text: 'For a booking proposal use the installed partner hotel rate and a private profile reference supplied by the owner. Present the preview terms and digest. Report payment and hotel confirmation only with independent evidence.' },
      { action: 'PrepareFliggyFlightBooking', text: 'For a booking proposal use the installed partner fare and a private profile reference supplied by the owner. Present the preview terms and digest. Report payment and ticket issuance only with independent evidence.' },
    ],
  },
  {
    apiName: 'Dining',
    terms: ['餐厅', '订位', '约饭', '吃饭', '菜单', '大众点评', 'dianping', 'restaurant', 'dining', 'table availability',
      '订座', '位子', '好吃', '餐馆', '吃什么', '订餐', '午饭', '晚饭'],
    actions: ['StageDiningActivity'],
    functions: ['readDiningAvailability', 'readDiningWebAvailability', 'readDiningMiniProgramAvailability',
      'searchDianpingRestaurants', 'readDianpingRestaurant'],
    instructions: [
      { action: 'StageDiningActivity', function: 'readDiningAvailability', text: 'For a dining day trip, verify the exact dish and meal window independently, check driving legs and weather as needed, and stage the meal with its original PA evidence request ID. Confirm that the full trip fits the original PA calendar.' },
    ],
  },
  {
    apiName: 'MapsAndWeather',
    terms: ['高德', '地图', '天气', '驾车', '导航', '路线', 'weather', 'forecast', 'map', 'driving',
      '下雨', '下雪', '气温', '温度', '刮风', '怎么走', '多远', '堵车'],
    functions: ['readMapPlace', 'geocodeAddress', 'reverseGeocode', 'searchMapPlaces', 'searchNearbyPlaces', 'estimateMapRoute', 'readWeather'],
    instructions: [
      { function: 'readWeather', text: 'Use the requested city or place first. Select current for measured conditions and forecast for a future date. Preserve whether the supplier reported current conditions or a daily forecast.' },
    ],
  },
  {
    apiName: 'CoffeePickup',
    terms: ['瑞幸', '咖啡', 'luckin', 'coffee', '拿铁', '美式', '生椰', '卡布奇诺'],
    actions: ['PreviewLuckinPickup', 'SubmitLuckinPickup'],
    functions: ['readLuckinPickup'],
    instructions: [
      { action: 'PreviewLuckinPickup', text: 'For explicitly requested pickup terms, have the original PA confirm the store, exact SKUs and quantities. Present the preview in the original task and preserve its confirmation and supplier receipt.' },
      { action: 'SubmitLuckinPickup', text: 'Recover an uncertain submission by reading the original order. Report payment only when the provider confirms it.' },
    ],
  },
  {
    apiName: 'Events',
    terms: ['luma', '报名', '活动', 'event registration', '讲座', '聚会', 'meetup'],
    actions: ['SearchLumaEvents', 'PrepareEventRegistration'],
    functions: ['readServiceSearch', 'readServiceOffering'],
    instructions: [
      { action: 'SearchLumaEvents', text: 'Use the original PA-connected account when no server connection is available. A provider information request pauses this exact task. Preserve its request ID and source identity.' },
      { action: 'PrepareEventRegistration', text: 'Report the state evidenced by the workflow. A proposed registration awaits approval, and accepted registration requires independently observed supplier evidence.' },
    ],
  },
  {
    apiName: 'TravelMonitoring',
    terms: ['行程提醒', '追踪航班', '航班提醒', '航班监控', 'travel reminder', 'flight watch', 'flight tracking',
      '延误', '航班动态', '航班状态', '起飞时间', '到达时间'],
    functions: ['readCalendarJourney', 'readFlightWatch', 'readDidiRideWatch'],
    instructions: [
      { function: 'readCalendarJourney', text: 'Use the original journey reference to read the current reminder. Starting or stopping monitoring requires the PA to explicitly submit the corresponding Action with the selected event identities.' },
    ],
  },
];
