import type { ResourceType } from "../../generated/prisma/client";
import { INSTAGRAM_PUBLISH_SCOPES, PAGE_PUBLISH_SCOPES } from "../integrations/meta.service";

/** Un refus prévisible : un `type` stable (le Plugin WP s'appuie dessus), une explication, et ses précisions. */
export interface Refusal {
  type: string;
  detail: string;
  [extension: string]: unknown;
}

/** Une image de la médiathèque WordPress, décrite par le Plugin WP : Meta ira la chercher à son URL. */
export interface ImageRef {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  size: number; // octets
}

/** Les formats de Publication. Les reels viendront avec le ticket 14. */
export const FORMATS = ["post", "story"] as const;
export type PublicationFormat = (typeof FORMATS)[number];

/** Ce qu'un format accepte sur un réseau, connu sans l'appeler. */
export interface FormatRules {
  /** false : le texte doit être vide (une story n'a pas de légende) */
  text: boolean;
  maxTextLength: number;
  maxHashtags?: number;
  maxMentions?: number;
  minImages: number;
  maxImages: number;
  maxImageBytes: number;
  imageTypes: string[];
  /** largeur / hauteur acceptée */
  aspectRatio?: { min: number; max: number; label: string };
}

/** Ce qu'un réseau accepte. */
export interface NetworkRules {
  label: string;
  /** les permissions Meta que l'Intégration doit avoir accordées */
  scopes: string[];
  /** true : la publication passe par le jeton de la page, obtenu via l'Intégration (Facebook) */
  pageToken: boolean;
  formats: Partial<Record<PublicationFormat, FormatRules>>;
}

const JPEG = ["image/jpeg", "image/jpg", "image/pjpeg"];
const MB = 1024 * 1024;

/**
 * Les règles par type de Ressource. Un type absent ne se diffuse pas : refus `resource-type-unsupported` ;
 * un format absent non plus : refus `format-unsupported`.
 *
 * Page Facebook (developers.facebook.com, Graph API, pages « Page Photos » et « Page Feed ») :
 *  - permissions : PAGE_PUBLISH_SCOPES (meta.service.ts) ;
 *  - images : .jpeg, .bmp, .png, .gif, .tiff, 4 Mo au plus ;
 *  - la longueur du texte et le nombre de photos par post ne sont pas documentés par Meta :
 *    63 206 caractères (limite connue des posts Facebook) et 10 images (limite du Manager Digital) ;
 *  - stories : ticket 14.
 *
 * Compte Instagram (developers.facebook.com, « Content Publishing » et « IG User Media ») :
 *  - permissions : INSTAGRAM_PUBLISH_SCOPES (meta.service.ts) ;
 *  - images : JPEG seulement, 8 Mo au plus ; proportions d'un post entre 4:5 et 1,91:1 ;
 *  - légende : 2 200 caractères, 30 hashtags, 20 mentions au plus ;
 *  - carrousel : 10 images (la doc dit 20, mais l'erreur 2207028 de Meta dit 10 : le plus strict) ;
 *  - story : une image, sans légende (l'API n'en prévoit pas).
 *
 * Le format d'une image est le type MIME annoncé par le Plugin WP : une image mal décrite sera
 * refusée par Meta, et tracée comme telle.
 */
export const NETWORK_RULES: Partial<Record<ResourceType, NetworkRules>> = {
  FACEBOOK_PAGE: {
    label: "Facebook",
    scopes: PAGE_PUBLISH_SCOPES,
    pageToken: true,
    formats: {
      post: {
        text: true,
        maxTextLength: 63_206,
        minImages: 0,
        maxImages: 10,
        maxImageBytes: 4 * MB,
        imageTypes: [...JPEG, "image/png", "image/gif", "image/bmp", "image/tiff"],
      },
    },
  },
  INSTAGRAM_ACCOUNT: {
    label: "Instagram",
    scopes: INSTAGRAM_PUBLISH_SCOPES,
    pageToken: false,
    formats: {
      post: {
        text: true,
        maxTextLength: 2_200,
        maxHashtags: 30,
        maxMentions: 20,
        minImages: 1,
        maxImages: 10,
        maxImageBytes: 8 * MB,
        imageTypes: JPEG,
        aspectRatio: { min: 4 / 5, max: 1.91, label: "entre 4:5 et 1,91:1" },
      },
      story: { text: false, maxTextLength: 0, minImages: 1, maxImages: 1, maxImageBytes: 8 * MB, imageTypes: JPEG },
    },
  },
};

/** Les refus qui ne dépendent que du contenu : format, texte et images. */
export function contentRefusals(network: NetworkRules, format: string, text: string, images: ImageRef[]): Refusal[] {
  const rules = network.formats[format as PublicationFormat];
  if (!rules) {
    const supportedFormats = Object.keys(network.formats);
    return [
      {
        type: "format-unsupported",
        detail: `${network.label} ne prend pas (encore) en charge le format « ${format} » (formats : ${supportedFormats.join(", ")})`,
        supportedFormats,
      },
    ];
  }

  const label = network.label;
  const refusals: Refusal[] = [];
  if (!rules.text && text.trim() !== "") {
    refusals.push({ type: "story-text-unsupported", detail: `Une story ${label} ne porte ni texte ni lien : laisser le texte vide` });
  }
  // en unités UTF-16 (un emoji peut en compter deux) : le plus strict, Meta ne dit pas comment il compte
  if (rules.text && text.length > rules.maxTextLength) {
    refusals.push({ type: "text-too-long", detail: `${label} accepte ${rules.maxTextLength} caractères au plus`, maxLength: rules.maxTextLength });
  }
  // un hashtag commence un mot : l'ancre d'une URL (« …/actu#commentaires ») n'en est pas un
  const hashtags = text.match(/(?<![\p{L}\p{N}_/])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (rules.maxHashtags !== undefined && hashtags > rules.maxHashtags) {
    refusals.push({ type: "too-many-hashtags", detail: `${label} accepte ${rules.maxHashtags} hashtags au plus`, maxHashtags: rules.maxHashtags });
  }
  // une mention commence un mot : « contact@site.fr » n'en est pas une
  const mentions = text.match(/(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu)?.length ?? 0;
  if (rules.maxMentions !== undefined && mentions > rules.maxMentions) {
    refusals.push({ type: "too-many-mentions", detail: `${label} accepte ${rules.maxMentions} mentions au plus`, maxMentions: rules.maxMentions });
  }

  if (images.length < rules.minImages) {
    refusals.push({ type: "image-required", detail: `${label} exige au moins une image pour ce format`, minImages: rules.minImages });
  }
  if (images.length > rules.maxImages) {
    refusals.push({ type: "too-many-images", detail: `${label} accepte ${rules.maxImages} image(s) au plus pour ce format`, maxImages: rules.maxImages });
  }
  const badFormat = images.filter((i) => !rules.imageTypes.includes(i.mimeType)).map((i) => i.url);
  if (badFormat.length > 0) {
    refusals.push({
      type: "image-format-unsupported",
      detail: `${label} n'accepte pas ce format d'image (formats acceptés : ${rules.imageTypes.join(", ")})`,
      images: badFormat,
      acceptedTypes: rules.imageTypes,
    });
  }
  const tooLarge = images.filter((i) => i.size > rules.maxImageBytes).map((i) => i.url);
  if (tooLarge.length > 0) {
    refusals.push({
      type: "image-too-large",
      detail: `${label} accepte des images de ${rules.maxImageBytes / MB} Mo au plus`,
      images: tooLarge,
      maxBytes: rules.maxImageBytes,
    });
  }
  const ratio = rules.aspectRatio;
  // arrondi au centième, comme Meta : une image 1200 × 628 (1,9108) est bien en 1,91:1
  const ratioOf = (i: ImageRef) => Math.round((i.width / i.height) * 100) / 100;
  const badRatio = ratio ? images.filter((i) => ratioOf(i) < ratio.min || ratioOf(i) > ratio.max).map((i) => i.url) : [];
  if (ratio && badRatio.length > 0) {
    refusals.push({
      type: "image-aspect-ratio",
      detail: `${label} exige des proportions ${ratio.label} (largeur / hauteur)`,
      images: badRatio,
      minRatio: ratio.min,
      maxRatio: ratio.max,
    });
  }
  return refusals;
}
