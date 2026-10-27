// EIGOS managed ontology operator guard. Configure and deploy separately from
// self-service enrollment; this Action never adds permissions to a token.
exports.onExecutePostLogin = async (event, api) => {
  const resource = event.secrets.EIGOS_RESOURCE;
  const client = event.secrets.EIGOS_ONTOLOGY_OPERATOR_CLIENT_ID;
  const subject = event.secrets.EIGOS_ONTOLOGY_OPERATOR_SUBJECT;
  const scopes = ['ontology:read', 'ontology:write', 'ontology:publish', 'ontology:admin'];
  if (client && event.client.client_id === client) {
    if (!resource || !subject || event.resource_server?.identifier !== resource || event.user?.user_id !== subject) {
      api.access.deny('This ontology management entry is not available to this identity.');
    }
    return;
  }
  if (resource && event.resource_server?.identifier === resource) {
    for (const scope of scopes) api.accessToken.removeScope(scope);
  }
};
