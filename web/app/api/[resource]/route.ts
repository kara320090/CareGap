import { publicQuery } from '../../../lib/caregap/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{resource:string}>}){return publicQuery(request,(await params).resource);}
