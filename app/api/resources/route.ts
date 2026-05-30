import { getResourcesPayload } from '@/lib/resources/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = await getResourcesPayload();
  return Response.json(payload);
}
