import type { ResourceType } from "../../generated/prisma/client";
import { PAGE_PUBLISH_SCOPES } from "../integrations/meta.service";

/** Un refus prévisible : un `type` stable (le Plugin WP s'appuie dessus), une explication, et ses précisions. */
export interface Refusal {
  type: string;
  detail: string;
  [extension: string]: unknown;
}

/** Ce qu'un réseau accepte, connu sans l'appeler. */
export interface NetworkRules {
  label: string;
  /** les permissions Meta que l'Intégration doit avoir accordées */
  scopes: string[];
  maxTextLength: number;
  maxImages: number;
  maxImageBytes: number;
  imageTypes: string[];
}

/**
 * Les règles par type de Ressource. Un type absent ne se diffuse pas (encore) : refus
 * `resource-type-unsupported`.
 *
 * Page Facebook (developers.facebook.com, Graph API, pages « Page Photos » et « Page Feed ») :
 *  - permissions : PAGE_PUBLISH_SCOPES (meta.service.ts) ;
 *  - images : .jpeg, .bmp, .png, .gif, .tiff, 4 Mo au plus. Le format est celui annoncé par le
 *    Plugin WP (type MIME) : une image mal étiquetée sera refusée par Meta, et tracée comme telle ;
 *  - la longueur du texte et le nombre de photos par post ne sont pas documentés par Meta :
 *    63 206 caractères (limite connue des posts Facebook) et 10 images (limite du Manager Digital).
 */
export const NETWORK_RULES: Partial<Record<ResourceType, NetworkRules>> = {
  FACEBOOK_PAGE: {
    label: "Facebook",
    scopes: PAGE_PUBLISH_SCOPES,
    maxTextLength: 63_206,
    maxImages: 10,
    maxImageBytes: 4 * 1024 * 1024,
    imageTypes: ["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/bmp", "image/tiff"],
  },
};

/** Les refus qui ne dépendent que du contenu : texte et images. */
export function contentRefusals(rules: NetworkRules, text: string, images: { mimetype: string; originalname: string; size: number }[]) {
  const refusals: Refusal[] = [];
  // en unités UTF-16 (un emoji peut en compter deux) : le plus strict, Meta ne dit pas comment il compte
  if (text.length > rules.maxTextLength) {
    refusals.push({
      type: "text-too-long",
      detail: `${rules.label} accepte ${rules.maxTextLength} caractères au plus`,
      maxLength: rules.maxTextLength,
    });
  }
  if (images.length > rules.maxImages) {
    refusals.push({
      type: "too-many-images",
      detail: `${rules.label} accepte ${rules.maxImages} images au plus par Publication`,
      maxImages: rules.maxImages,
    });
  }
  const badFormat = images.filter((i) => !rules.imageTypes.includes(i.mimetype)).map((i) => i.originalname);
  if (badFormat.length > 0) {
    refusals.push({
      type: "image-format-unsupported",
      detail: `${rules.label} n'accepte pas ce format d'image (formats acceptés : ${rules.imageTypes.join(", ")})`,
      images: badFormat,
      acceptedTypes: rules.imageTypes,
    });
  }
  const tooLarge = images.filter((i) => i.size > rules.maxImageBytes).map((i) => i.originalname);
  if (tooLarge.length > 0) {
    refusals.push({
      type: "image-too-large",
      detail: `${rules.label} accepte des images de ${rules.maxImageBytes / (1024 * 1024)} Mo au plus`,
      images: tooLarge,
      maxBytes: rules.maxImageBytes,
    });
  }
  return refusals;
}
