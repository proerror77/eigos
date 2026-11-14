export async function currentTaskLocation(geolocation, request, now = Date.now) {
  // Browser coordinates remain WGS84 even when the requested provider uses GCJ-02.
  if (request.coordinateSystem !== 'wgs84' && !request.acceptDeviceWgs84) {
    throw new Error('此查询需要高德坐标。请在个人助手中选择地图位置，或指定收餐地址。');
  }
  if (!geolocation) throw new Error('此浏览器无法定位。请从手机打开工作台，或提供地址。');
  const position = await new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }).catch((error) => {
    throw new Error(error?.code === 1 ? '未获得设备位置权限。你可以提供地址继续查询。' : '未能取得设备位置。你可以提供地址继续查询。');
  });
  const { latitude, longitude, accuracy } = position.coords;
  const measuredAt = position.timestamp, time = now();
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new Error('设备未返回可用的地图位置。');
  if (!Number.isFinite(measuredAt) || measuredAt > time + 5000 || time - measuredAt >= request.maxAgeMs ||
      !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > request.maxAccuracyMeters) {
    throw new Error('设备定位已过期或精度不足，请重新定位或提供地址。');
  }
  return {
    status: 'available',
    location: { source: 'device', coordinateSystem: 'wgs84', latitude, longitude,
      accuracyMeters: accuracy, observedAt: new Date(measuredAt).toISOString() },
  };
}
