// EIGOS managed member-identity binding. This Action is restricted to this portal/API.
exports.onExecutePostLogin = async (event, api) => {
  const resource = event.secrets.EIGOS_RESOURCE;
  const portal = event.secrets.EIGOS_MEMBER_CLIENT_ID;
  const legacy = event.secrets.EIGOS_LEGACY_RESOURCE;
  const forApi = !!resource && (event.resource_server?.identifier === resource
    || (!!legacy && resource === legacy + '/' && event.resource_server?.identifier === legacy));
  const forPortal = !!portal && event.client.client_id === portal;
  if (!forApi && !forPortal) return;
  const claim = event.secrets.EIGOS_TENANT_CLAIM;
  const tenant = event.secrets.EIGOS_TENANT_ID;
  if (!claim || !tenant) { api.access.deny('EIGOS identity mapping is not configured'); return; }
  // The first personal-member tenant is administrator-controlled, never taken from user_metadata or input.
  api.idToken.setCustomClaim(claim, tenant);
  if (forApi) {
    api.accessToken.setCustomClaim(claim, tenant);
    if (event.client.client_id === event.secrets.EIGOS_AGENT_CONNECTOR_CLIENT_ID) {
      // A refresh grant can continue its installation, but cannot enroll a new
      // installation to bypass that Agent's revocation. Unknown flows fail closed.
      api.accessToken.setCustomClaim(`${resource.replace(/\/$/, '')}/claims/agent_enrollment`, event.transaction?.protocol === 'oauth2-device-code');
    }
  }
};
