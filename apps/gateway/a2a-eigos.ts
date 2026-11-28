import express from 'express';
import { AgentCard } from '@a2a-js/sdk';
import type { Config } from '../../packages/core/config.js';
import { businessAgentProfiles, type AgentProfile } from '../../packages/ontology/agent-profiles.js';
import { accountTaskScopes } from '../../packages/runtime/accounts.js';
import type { InstalledRuntime } from '../../packages/runtime/installation.js';

export const A2A_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/a2a';

const SKILL_DISPLAY: Record<string, { name: string; summary: string }> = {
  MapsAndWeather: {
    name: 'Maps & Weather',
    summary: 'Query live weather, forecasts, places, geocoding, and driving routes via Amap.',
  },
  Dining: {
    name: 'Restaurants & Dining',
    summary: 'Search restaurant listings, reviews, and table availability.',
  },
  TravelOffers: {
    name: 'Flights & Hotels',
    summary: 'Search flight offers, hotel rates, and travel handoffs across connected suppliers.',
  },
  RideQuote: {
    name: 'Ride Estimate',
    summary: 'Resolve route endpoints and return provider fare estimates and ride links.',
  },
  SchedulePlanning: {
    name: 'Calendar Planning',
    summary: 'Request calendar availability from the original PA and compare scheduling scenarios without external calendar writes.',
  },
  AmapTransport: {
    name: 'Transit & Traffic',
    summary: 'Plan transit, cycling, and driving routes, measure distances, and inspect live traffic.',
  },
  TravelMonitoring: {
    name: 'Travel & Flight Monitoring',
    summary: 'Read calendar journey reminders, flight watches, and ride tracking status.',
  },
  BookedFlightMonitoring: {
    name: 'Booked Flight Alerts',
    summary: 'Monitor booked flights for schedule changes and status updates.',
  },
  TravelOrderProgress: {
    name: 'Travel Order Progress',
    summary: 'Check supplier-verified hotel cancellation, refund, and flight ticket issuance status.',
  },
  PersonalPlaces: {
    name: 'Personal Places',
    summary: 'Manage saved personal addresses (such as home and work) and search nearby places.',
  },
  DidiImmediateBooking: {
    name: 'Ride Booking',
    summary: 'Coordinate immediate ride booking with explicit PA fare confirmation.',
  },
  DidiOrderManagement: {
    name: 'Ride Order Management',
    summary: 'Track active ride orders, driver position, reconciliation, and cancellation.',
  },
  DidiMaps: {
    name: 'DiDi Maps',
    summary: 'Reverse geocode locations, search nearby places, and estimate routes via DiDi Maps.',
  },
  CoffeePickup: {
    name: 'Coffee Pickup',
    summary: 'Preview and track coffee pickup orders with PA confirmation.',
  },
  Events: {
    name: 'Events & Meetups',
    summary: 'Search events and prepare event registrations with supplier verification.',
  },
  PetRideTrial: {
    name: 'Pet-Friendly Ride',
    summary: 'Prepare and record pet-friendly ride handoffs.',
  },
};

function humanizeApiName(apiName: string): string {
  return apiName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
}

function summarizeProfile(profile: AgentProfile): { id: string; name: string; description: string; tags: string[] } {
  const preset = SKILL_DISPLAY[profile.apiName];
  const firstInstruction = profile.instructions?.[0]?.text ?? '';
  const description = preset?.summary
    ?? (firstInstruction.length > 200 ? firstInstruction.slice(0, 197) + '...' : firstInstruction)
    ?? `Published EIGOS capability for ${humanizeApiName(profile.apiName)}.`;
  return {
    id: profile.apiName.charAt(0).toLowerCase() + profile.apiName.slice(1),
    name: preset?.name ?? humanizeApiName(profile.apiName),
    description,
    tags: profile.terms.slice(0, 12),
  };
}

function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer : issuer + '/';
}

/**
 * Builds the EIGOS A2A AgentCard with dynamic skills derived from published EIGOS
 * `agentProfiles` (plus any runtime `publicSkills`) and full `bearer` + `oauth2` + `openIdConnect`
 * security schemes when `OAUTH_ISSUER` is configured.
 */
export function eigosAgentCard(publicUrl: string, config: Config, capabilities?: InstalledRuntime): AgentCard {
  const skillsById = new Map<string, { id: string; name: string; description: string; tags: string[] }>();

  for (const profile of businessAgentProfiles) {
    const skill = summarizeProfile(profile);
    skillsById.set(skill.id, skill);
  }
  for (const extra of capabilities?.publicSkills ?? []) {
    if (!skillsById.has(extra.id)) {
      skillsById.set(extra.id, {
        id: extra.id,
        name: extra.name,
        description: extra.description,
        tags: [...extra.tags],
      });
    }
  }

  const securitySchemes: Record<string, unknown> = {
    bearer: {
      httpAuthSecurityScheme: {
        scheme: 'Bearer',
        bearerFormat: 'JWT or eigos_agent token',
        description: 'Bearer authentication using an OAuth 2.0 JWT or an EIGOS persistent PA token (eigos_agent_*).',
      },
    },
  };

  const securityRequirements: Array<{ schemes: Record<string, { list: string[] }> }> = [
    { schemes: { bearer: { list: [] } } },
  ];

  if (config.OAUTH_ISSUER) {
    const issuer = normalizeIssuer(config.OAUTH_ISSUER);
    const a2aResource = `${publicUrl}/a2a`;
    securitySchemes.oauth2 = {
      oauth2SecurityScheme: {
        description: 'OAuth 2.0 Authorization Code flow with PKCE for EIGOS A2A.',
        oauth2MetadataUrl: `${issuer}.well-known/oauth-authorization-server`,
        flows: {
          authorizationCode: {
            authorizationUrl: `${issuer}authorize?audience=${encodeURIComponent(a2aResource)}`,
            tokenUrl: `${issuer}oauth/token`,
            scopes: {
              'tasks:read': 'Read your EIGOS tasks, status updates, and results',
              'tasks:write': 'Submit, respond to, and cancel your EIGOS tasks',
            },
          },
        },
      },
    };
    securitySchemes.openIdConnect = {
      openIdConnectSecurityScheme: {
        description: 'OpenID Connect Discovery for the EIGOS authorization server.',
        openIdConnectUrl: `${issuer}.well-known/openid-configuration`,
      },
    };
    securityRequirements.push(
      { schemes: { oauth2: { list: [...accountTaskScopes] } } },
      { schemes: { openIdConnect: { list: [] } } },
    );
  }

  return AgentCard.fromJSON({
    name: 'EIGOS',
    description: 'Source-backed inquiries, travel and dining research, and calendar-backed scenario scheduling through published Ontology queries, functions, and actions.',
    version: '0.2.0',
    supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [...skillsById.values()],
    securitySchemes,
    securityRequirements,
  });
}

/**
 * Mounts RFC 9728 Protected Resource Metadata for `/a2a` at
 * `/.well-known/oauth-protected-resource/a2a` whenever `OAUTH_ISSUER` is configured.
 */
export function mountA2AProtectedResourceMetadata(app: express.Express, config: Config): void {
  if (!config.OAUTH_ISSUER) return;
  app.get(A2A_PROTECTED_RESOURCE_METADATA_PATH, (_req, res) => res.json({
    resource: `${config.PUBLIC_URL}/a2a`,
    authorization_servers: [config.OAUTH_ISSUER],
    scopes_supported: [...accountTaskScopes],
    bearer_methods_supported: ['header'],
  }));
}
