// Logo + metadata JSON upload to IPFS through Pinata: one authenticated HTTP
// upload each, no wallet interaction. The JWT should only carry the
// "Files: Write" permission, so shipping it in the bundle risks at most the
// account's storage quota.
import { PINATA_JWT } from './config'

const UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const GATEWAY = 'https://gateway.pinata.cloud/ipfs/'

export const uploadsEnabled = () => Boolean(PINATA_JWT)

async function pin(file: Blob, name: string): Promise<string> {
  if (!PINATA_JWT) throw new Error('Uploads are not configured on this deployment.')
  const form = new FormData()
  form.append('file', file, name)
  form.append('name', name)
  form.append('network', 'public')
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text().catch(() => res.statusText)}`)
  const json = (await res.json()) as { data?: { cid?: string } }
  if (!json.data?.cid) throw new Error('Upload succeeded but returned no content id.')
  return `${GATEWAY}${json.data.cid}`
}

export interface MetadataInput {
  name: string
  symbol: string
  description: string
  website: string
  twitter: string
  telegram: string
}

export async function uploadMetadata(
  image: File,
  input: MetadataInput,
  onStatus?: (s: string) => void,
): Promise<string> {
  onStatus?.('Uploading image…')
  const imageUrl = await pin(image, image.name || 'logo')
  const json = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: imageUrl,
    external_url: input.website || undefined,
    extensions: {
      website: input.website || undefined,
      twitter: input.twitter || undefined,
      telegram: input.telegram || undefined,
    },
    properties: { files: [{ uri: imageUrl, type: image.type || 'image/png' }], category: 'image' },
  }
  onStatus?.('Uploading metadata…')
  return pin(new Blob([JSON.stringify(json)], { type: 'application/json' }), 'metadata.json')
}
