import { routes } from './routes'
import { ref, schemas } from './schemas'

const TAG_DESCRIPTIONS: Record<string, string> = {
  Meta: 'Status und Versionen',
  Accounts: 'Konfigurierte Claude-Accounts (ohne Secrets)',
  Usage: 'Plan-Limits und Token-Verbrauch',
  Sessions: 'Gespeicherte Claude-Code-Sessions, gruppiert nach Account',
  Terminals: 'Laufende Terminals der App steuern',
  Events: 'Live-Ereignisse per Server-Sent Events',
}

/** OpenAPI 3.1 document generated from the route table, so code and docs never drift apart. */
export function buildOpenApi(baseUrl: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of routes) {
    const { doc } = route
    const parameters = [
      ...(doc.pathParams ?? []).map((p) => ({
        name: p.name,
        in: 'path',
        required: true,
        description: p.description,
        schema: p.schema ?? { type: 'string' },
      })),
      ...(doc.queryParams ?? []).map((p) => ({
        name: p.name,
        in: 'query',
        required: p.required ?? false,
        description: p.description,
        schema: p.schema ?? { type: 'string' },
      })),
    ]
    const responses: Record<string, unknown> = doc.response
      ? {
          '200': {
            description: doc.response.description,
            content: { [doc.response.contentType ?? 'application/json']: { schema: doc.response.schema ?? {} } },
          },
        }
      : { '204': { description: 'Erfolgreich, keine Antwortdaten' } }
    const errorResponse = (description: string) => ({
      description,
      content: { 'application/json': { schema: ref('Error') } },
    })
    responses['400'] = errorResponse('Ungültige Anfrage')
    if (!doc.public) responses['401'] = errorResponse('Token fehlt oder ist falsch')
    if (doc.pathParams?.length) responses['404'] = errorResponse('Nicht gefunden')

    paths[route.path] ??= {}
    paths[route.path][route.method.toLowerCase()] = {
      tags: [doc.tag],
      summary: doc.summary,
      ...(doc.description ? { description: doc.description } : {}),
      operationId: `${route.method.toLowerCase()}${route.path
        .replace('/api/v1', '')
        .split('/')
        .filter(Boolean)
        .map((part) => part.replace(/[{}]/g, ''))
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}`,
      ...(parameters.length ? { parameters } : {}),
      ...(doc.requestBody
        ? {
            requestBody: {
              required: doc.requestBody.required ?? true,
              content: {
                'application/json': {
                  schema: doc.requestBody.schema,
                  ...(doc.requestBody.example !== undefined ? { example: doc.requestBody.example } : {}),
                },
              },
            },
          }
        : {}),
      responses,
      ...(doc.public ? { security: [] } : {}),
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Claude Manager – lokale API',
      version,
      description:
        'Steuert Claude Manager von anderen Programmen aus. Der Server lauscht nur auf 127.0.0.1; jede Anfrage braucht den Token aus Einstellungen → API als `Authorization: Bearer <token>`.',
    },
    servers: [{ url: baseUrl }],
    tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas,
    },
  }
}
