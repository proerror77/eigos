import { localDeliveryProviders } from './local-delivery.js';
import { deliveryTradeServices } from './local-delivery-trade.js';
import { bookImmediateRideAction, immediateRideInterface, immediateRideType } from './didi-immediate-ride.js';
import { partnerRideServices } from './partner-rides.js';
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
    terms: ['打车', '滴滴', '估价', '车费', '车价', '询价', '出租车', 'didi', 'taxi', 'ride quote', 'fare only', 'fare estimate', '打车链接', '滴滴跳转', '滴滴小程序', 'ride link',
      '叫车', '叫个车', '叫辆车', '打个车', '打辆车', '网约车', '专车', '快车', '用车'],
    objects: ['RideRequest', 'Route', 'Place', 'RideEstimate'],
    interfaces: ['RideInquiry', 'RideInquiryWithPlaceClues', 'RideEstimatable'],
    actions: ['EstimateRide', 'EstimateRideWithPlaceClues'],
    functions: ['readRideEstimates', 'readInteractiveRideEstimate', 'generateDidiRideAppLink'],
    instructions: [
      { function: 'generateDidiRideAppLink', text: 'When asked for an App or mini-program link, use complete_with_action with the ride estimate Interface Action and generateDidiRideAppLink as the result Function (resultParameter: request). Pass serviceClass only for a vehicle the user selected. For an existing quote, pass its RideRequest reference and, when applicable, the selected RideEstimate. The user completes the booking on DiDi.' },
      { action: 'EstimateRide', function: 'readRideEstimates', text: 'When the user provides the city, pickup and destination for a DiDi or provider-unspecified fare inquiry, use complete_with_action with RideInquiry.estimate on RideRequest and readRideEstimates (resultParameter: request). Include serviceClass only for a specified vehicle class.' },
      { action: 'EstimateRideWithPlaceClues', function: 'readInteractiveRideEstimate', text: 'For DiDi or provider-unspecified read-only inquiries, use RideInquiryWithPlaceClues.estimate on RideRequest with readInteractiveRideEstimate when the user also requests driving time, provides landmark clues, or the named ride inquiry cannot be used. Pass a given pickup or itinerary point as origin. With authorized device location, omit origin to ask the original PA for fresh phone location and verify its coordinate system. Omit a missing destination so the Action asks for it. Pass only a city established by the user. Keep nearby landmarks separate and preserve ambiguous names for the Action to resolve.' },
    ],
  },
  {
    apiName: 'PartnerRideQuote',
    terms: ['Uber', '优步', 'Grab'],
    functions: Object.values(partnerRideServices).map(service => service.function),
    instructions: [
      { function: partnerRideServices.Uber.function, text: 'For an explicit Uber request use estimateUberRide. Use only confirmed WGS84 endpoints and addresses. Ask for missing or ambiguous locations. Return the Uber handoff for the user to confirm in the App.' },
      { function: partnerRideServices.Grab.function, text: 'For an explicit Grab request use estimateGrabRide. Use only confirmed WGS84 endpoints and addresses. Ask for missing or ambiguous locations. Return the Grab handoff for the user to confirm in the App.' },
    ],
  },
  {
    apiName: 'DidiImmediateBooking',
    terms: ['叫车', '叫个车', '叫一辆车', '叫辆车', '打个车', '打一辆车', '打辆车', '现在打车', '现在下单', 'book a ride', 'call a taxi'],
    objects: [immediateRideType, 'DidiRideOrder'],
    interfaces: [immediateRideInterface],
    actions: [bookImmediateRideAction],
    functions: ['readDidiImmediateRide'],
    instructions: [{
      action: bookImmediateRideAction, function: 'readDidiImmediateRide',
      text: 'For an explicit request to book a ride now on DiDi or with no named provider, such as 帮我叫辆车, use complete_with_action with ImmediateRideBooking.book on DidiImmediateRide and readDidiImmediateRide (resultParameter: ride). Pass only known endpoints and an explicitly requested vehicle and let the Action ask for missing inputs and obtain authenticated PA approval. If the request is only a quote, an App link or a future ride, use the corresponding inquiry or planning capability.',
    }],
  },
  {
    apiName: 'DidiOrderManagement',
    terms: ['取消滴滴', '取消订单', '取消打车', '取消叫车', '滴滴订单', '滴滴司机', 'cancel ride', 'cancel taxi', 'didi order'],
    objects: ['DidiRideOrder', 'DidiRideWatch', 'EventTrip', immediateRideType],
    interfaces: ['RideOrder', 'CancelableRideOrder'],
    actions: ['CancelDidiRideOrder', 'RefreshDidiRideOrder', 'StartDidiRideWatch', 'StopDidiRideWatch'],
    functions: ['readDidiRideOrder', 'readDidiRideWatch', 'readDidiDriverPosition'],
    instructions: [
      { function: 'readDidiRideWatch', text: 'For pickup and journey progress follow the original DidiRideOrder.watches link and read the matching watch. Report its observedAt and reason. Stopped or expired tracking does not establish ride completion or settlement.' },
      { action: 'CancelDidiRideOrder', function: 'readDidiRideOrder', text: 'Identify the exact linked original DiDi order. Cancellation is submitted directly by the authenticated PA through CancelableRideOrder.cancel with confirmCancellation=true after user approval. Read the original cancellation outcome before reporting success. An unresolved attempt permits readback only.' },
    ],
  },
  {
    apiName: 'DidiMaps',
    terms: ['滴滴地图', '滴滴路线', '滴滴周边', '滴滴地址', '滴滴公交', '滴滴步行', '滴滴骑行', 'didi maps'],
    functions: ['reverseGeocodeDidi', 'searchDidiNearbyPlaces', 'estimateDidiMapRoute'],
  },
  {
    apiName: 'PetRideTrial',
    terms: ['宠物', '携宠', '带狗', '带猫', '带着狗', '带着猫', '狗狗', '猫咪', 'pet ride', 'pet-friendly ride'],
    objects: ['PetRideHandoff'],
    interfaces: ['PetRide'],
    actions: ['PreparePetRideHandoff', 'RecordPetRideReceipt'],
    functions: ['readPetRideHandoff'],
    instructions: [
      { action: 'PreparePetRideHandoff', function: 'readPetRideHandoff', text: 'For an explicitly requested synthetic pet ride trial, apply PreparePetRideHandoff with the exact pickup, destination, pet details and requested pet vehicle. Then use complete_with_action for the returned object’s PetRide.recordReceipt with readPetRideHandoff (resultParameter: handoff). The original PA provides the test quote, approval and original-order readback. Ordinary DiDi quotes do not establish that a car accepts pets.' },
    ],
  },
  {
    apiName: 'SchedulePlanning',
    terms: ['日历', '排程', '行程', '安排', '时段', 'schedule', 'calendar', 'planning', 'itinerary', 'time slot',
      '日程', '有空吗', '有没有空', '什么时候有空', '哪天有空', '空闲时间', '有没有时间'],
    objects: ['SchedulePlan', 'ScheduledActivity', 'ScheduleResource', 'CalendarAvailability', 'SchedulePlanStateLog',
      'CalendarJourney', 'ItineraryContinuity', 'ItineraryContinuityStateLog'],
    interfaces: ['SchedulablePlan'],
    actions: ['PrepareSchedulePlan', 'SaveScheduleActivity', 'StageScheduleRecommendation',
      'AttachCalendarJourneyToPlan', 'StartItineraryContinuity', 'BindItinerarySource', 'EnableItineraryAutomation',
      'ApplyItineraryTransferProposal', 'AcknowledgeItineraryHandoff', 'StopItineraryContinuity'],
    functions: ['findScheduleSlots', 'readSchedulePlan', 'validateSchedule', 'recommendSchedule', 'readScheduleJourney'],
    instructions: [
      { action: 'PrepareSchedulePlan', text: 'Obtain calendar availability through the published planning capability. It requests authorized data from the original PA and resumes this same task. For replanning an existing SchedulePlan, create a Scenario first, call its live PrepareSchedulePlan Action with input.plan and input.scenarioId, then read and edit that same Scenario. Keep proposed fields staged and validate the returned plan. The PA explicitly applies a reviewed merge.' },
      { function: 'readScheduleJourney', text: 'After a calendar receipt, keep the returned SchedulePlan reference for activity edits and review. Use complete_with_function with that reference for a requested itinerary readback. If a required source, choice or approval is missing, use request_clarification on this same task and state what is missing.' },
      { action: 'StartItineraryContinuity', function: 'readScheduleJourney', text: 'Keep the original SchedulePlan. Read its linked calendar evidence, orders and follow-up before proposing a change. Ask the PA to explicitly start follow-up of the selected flight, transfer and hotel activities on that plan. Provide any verified original orders and the selected calendar monitor and revision to this Action for automatic reassessment.' },
      { action: 'ApplyItineraryTransferProposal', text: 'Apply only the exact internal transfer proposal reviewed by the owner after confirming there is no active ride to change. A real booking, modification or cancellation requires authorization for the original supplier Action.' },
    ],
  },
  {
    apiName: 'BookedFlightMonitoring',
    terms: ['行程监测','跟踪我的航班','关注航变','航班变动提醒','monitor my booked flight','flight change alert'],
    objects: ['FliggyFlightBooking','FlightWatch'], links: ['FliggyFlightBookingWatch'],
    functions: ['prepareBookedFlightWatch','readFliggyFlightBooking','readFlightWatch'],
    actions: ['StartBookedFlightWatch','CancelFlightWatch'],
    instructions: [
      { function:'prepareBookedFlightWatch', text:'Use the original booking to prepare a monitoring proposal. Present the chosen sources, maximum checks and deadline to the owner. A booking or payment approval applies only to that transaction.' },
      { action:'StartBookedFlightWatch', text:'Use monitoring settings explicitly authorized for this booking and leg. Read the linked watch for the latest provider evidence and changes.' },
    ],
  },
  {
    apiName: 'TravelOrderProgress',
    terms: ['酒店取消进度', '酒店退款进度', '机票出票', '出票了吗', 'hotel cancellation status', 'ticket issuance'],
    objects: ['FliggyHotelBooking','FliggyFlightBooking'],
    functions: ['readFliggyHotelBooking','readFliggyFlightBooking'],
    instructions: [
      { function: 'readFliggyHotelBooking', text: 'Identify the original booking and read its last verified supplier state and observation time. Distinguish cancellation from refund settlement. Query the booking for cancellationObservation when present.' },
      { function: 'readFliggyFlightBooking', text: 'Identify the original flight order. Report payment and ticket issuance separately using independent supplier evidence. Query issuanceState and issuanceObservation when present.' },
    ],
  },
  {
    apiName: 'TravelOffers',
    terms: ['酒店', '机票', '航班', 'hotel', 'flight', 'travel offer', 'rollinggo', 'fliggy', '飞猪',
      '住哪', '住宿', '订房', '宾馆', '民宿', '飞机'],
    objects: ['TravelOfferSearch','FliggyTravelOfferHandoff'],
    interfaces: ['TravelOfferSelection','TravelOfferInquiry', 'FlightSearch', 'HotelSearch', 'HotelOffer'],
    actions: ['PrepareFliggyTravelHandoff','SearchTravelOffers', 'SearchRollingGoHotels', 'PrepareFliggyHotelBooking', 'PrepareFliggyFlightBooking'],
    functions: ['readFliggyTravelHandoff','readTravelOfferSearch', 'readServiceSearchPages', 'readServiceSearch', 'readServiceOffering'],
    instructions: [
      { action: 'PrepareFliggyTravelHandoff', function:'readFliggyTravelHandoff', text:'When the user selects a FlyAI trial or keyed hotel or flight offer, call TravelOfferSelection.prepare on FliggyTravelOfferHandoff with the selected offer and its search page references. Return the verified supplier review link using readFliggyTravelHandoff bound to handoff. Keep the displayed fare and access mode. A handoff creates no supplier order.' },
      { action: 'SearchTravelOffers', function: 'readTravelOfferSearch', text: 'Use the TravelOfferInquiry.search Interface Action on TravelOfferSearch so the supplier reads run concurrently. Use the same user criteria for participating suppliers. For direct results use complete_with_action and bind readTravelOfferSearch to search. For a coordinated itinerary search before opening a Scenario. Preserve supplier outcomes, access mode and display prices.' },
      { action: 'PrepareFliggyHotelBooking', text: 'For a booking proposal use the installed partner hotel rate and a private profile reference supplied by the owner. Present the preview terms and digest. Report payment and hotel confirmation only with independent evidence.' },
      { action: 'PrepareFliggyFlightBooking', text: 'For a booking proposal use the installed partner fare and a private profile reference supplied by the owner. Present the preview terms and digest. Report payment and ticket issuance only with independent evidence.' },
    ],
  },
  ...localDeliveryProviders.map(provider => {
    const service = deliveryTradeServices[provider], { search, names, read } = service;
    const taobao = provider === 'TaobaoInstantDelivery';
    return {
      apiName: provider,
      terms: taobao ? ['淘宝闪购', '闪购', '淘宝外卖', 'taobao instant delivery'] : ['盒马', '盒马鲜生', 'hema', 'freshippo'],
      objects: [search.object, service.cartChangeType, service.checkoutType, service.orderType],
      interfaces: [search.inquiry, service.cartContract, service.orderContract],
      actions: [search.action, names.change, names.preview, names.submit, names.preparePayment, names.refresh,
        names.stopObservation, taobao ? names.pay : names.selectWindow],
      links: [service.searchCartLink, service.cartCheckoutLink, service.checkoutOrderLink],
      functions: [search.read, ...Object.values(read)],
      instructions: [
        { action: search.action, function: search.read, text: taobao
          ? 'Use the Taobao Instant Delivery account and chosen delivery address for dishes, nearby stores or menus. A Hema merchant returned by this source is a Taobao Instant Delivery observation.'
          : 'Use the direct Hema account and its selected delivery groups. Report listed prices, checked SKU stock, unknown quantities and verification requirements.' },
        { action: names.submit, function: read.checkout,
          text: 'Use ' + service.cartContract + '.change and ' + service.orderContract +
            '.submit with complete_with_action. Preserve the original search, checkout and PA approval from this service.' },
        taobao
          ? { action: names.pay, text: 'Obtain separate approval for the original Taobao Instant Delivery amount, then refresh its independent payment state.' }
          : { action: names.preparePayment, text: 'Hand off only the original Hema order to the Hema official app for payment.' },
      ],
    };
  }),
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
