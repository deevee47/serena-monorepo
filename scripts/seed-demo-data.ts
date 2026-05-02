/**
 * Seed demo data: products (chairs, proteins, clothes), reviews, customers, carts, purchases.
 *
 * Idempotent — uses upserts on stable IDs / phones so re-running won't duplicate.
 *
 * Usage: bun run scripts/seed-demo-data.ts
 */
import { PrismaClient, Prisma, CustomerSegment, CartStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Helpers ────────────────────────────────────────────────────────────────

type SeedProduct = {
  id: string;
  name: string;
  description: string;
  price: Prisma.Decimal;
  category: string;
  tags: string[];
  inventoryCount: number;
  metadata?: Prisma.InputJsonValue;
};

function dec(v: string | number): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ════════════════════════════════════════════════════════════════════════════
// CHAIRS + ACCESSORIES (Office)
// ════════════════════════════════════════════════════════════════════════════

const CHAIRS: SeedProduct[] = [
  {
    id: 'prod-001',
    name: 'ZephyrChair Pro',
    description:
      'Premium ergonomic office chair. 3D-adjustable lumbar support, breathable mesh back, 4D armrests, recline lock, 350lb weight rating. 5-year warranty.',
    price: dec('349.00'),
    category: 'Office',
    tags: ['chair', 'ergonomic', 'office', 'lumbar', 'mesh', 'adjustable', 'warranty-5yr', '350lb-rated'],
    inventoryCount: 4,
    metadata: {
      dimensions: { width_in: 27, depth_in: 26, height_in_min: 41, height_in_max: 47 },
      weight_capacity_lb: 350,
      warranty_years: 5,
      assembly: '20 min, tools included',
      armrest_dimensions: '4D adjustable (height/width/depth/angle)',
    },
  },
  {
    id: 'prod-002',
    name: 'ZephyrChair Lite',
    description:
      'Mid-tier ergonomic chair. Fixed-tilt lumbar, 2D armrests, mesh back, 280lb weight rating. 2-year warranty. Same family as the Pro at half the price.',
    price: dec('199.00'),
    category: 'Office',
    tags: ['chair', 'ergonomic', 'office', 'lumbar', 'mesh', 'budget', 'warranty-2yr', '280lb-rated'],
    inventoryCount: 22,
    metadata: {
      dimensions: { width_in: 26, depth_in: 25, height_in_min: 40, height_in_max: 44 },
      weight_capacity_lb: 280,
      warranty_years: 2,
    },
  },
  {
    id: 'chair-gamethrone',
    name: 'GameThrone Pro Gaming Chair',
    description:
      'High-back gaming chair with 135° recline, adjustable headrest pillow, lumbar pillow, 4D armrests, RGB-stitched backrest. Built for 8+ hour sessions. 330lb capacity, 3-year warranty.',
    price: dec('429.00'),
    category: 'Office',
    tags: ['chair', 'gaming', 'office', 'high-back', 'recline', 'rgb', 'streaming', 'warranty-3yr'],
    inventoryCount: 15,
    metadata: {
      dimensions: { width_in: 28, depth_in: 27, height_in_min: 49, height_in_max: 53 },
      weight_capacity_lb: 330,
      warranty_years: 3,
      recline_max_deg: 135,
    },
  },
  {
    id: 'chair-executive',
    name: 'Executive Leather Chair',
    description:
      'Top-grain leather executive chair. Polished aluminum base, integrated headrest, multi-position recline lock, 400lb weight rating. 7-year warranty.',
    price: dec('599.00'),
    category: 'Office',
    tags: ['chair', 'executive', 'office', 'leather', 'premium', 'warranty-7yr', '400lb-rated'],
    inventoryCount: 6,
    metadata: {
      dimensions: { width_in: 29, depth_in: 28, height_in_min: 44, height_in_max: 48 },
      weight_capacity_lb: 400,
      warranty_years: 7,
      material: 'Top-grain leather, aluminum base',
    },
  },
  {
    id: 'chair-mesh-task',
    name: 'MeshTask Office Chair',
    description:
      'Entry-level mesh task chair. Fixed armrests, tilt tension knob, breathable back, 250lb weight rating. 1-year warranty. Easy 10-min assembly.',
    price: dec('129.00'),
    category: 'Office',
    tags: ['chair', 'office', 'mesh', 'task', 'entry-level', 'warranty-1yr', 'budget'],
    inventoryCount: 38,
    metadata: {
      dimensions: { width_in: 24, depth_in: 23, height_in_min: 38, height_in_max: 42 },
      weight_capacity_lb: 250,
      warranty_years: 1,
      assembly: '10 min, tools included',
    },
  },
  {
    id: 'chair-kneeling',
    name: 'Kneeling Posture Chair',
    description:
      'Ergonomic kneeling chair for forward-tilted posture. Memory-foam seat + shin pads, sturdy steel frame, 220lb capacity. Reduces lumbar pressure on long sitting days.',
    price: dec('179.00'),
    category: 'Office',
    tags: ['chair', 'kneeling', 'posture', 'office', 'ergonomic', 'specialty', '220lb-rated'],
    inventoryCount: 12,
    metadata: {
      dimensions: { width_in: 22, depth_in: 28, height_in: 21 },
      weight_capacity_lb: 220,
      warranty_years: 1,
      use_case: 'Posture correction, forward-tilted work',
    },
  },
  {
    id: 'chair-saddle-stool',
    name: 'Saddle Stool Adjustable',
    description:
      'Saddle-shaped stool for active sitting. Pneumatic height adjust 22-32", 360° swivel, locking casters. Used in dental/medical offices. 250lb capacity.',
    price: dec('159.00'),
    category: 'Office',
    tags: ['stool', 'saddle', 'office', 'active-sitting', 'specialty', 'medical', '250lb-rated'],
    inventoryCount: 20,
    metadata: {
      dimensions: { width_in: 18, depth_in: 14, height_in_min: 22, height_in_max: 32 },
      weight_capacity_lb: 250,
      warranty_years: 2,
    },
  },
  {
    id: 'acc-mat-01',
    name: 'Anti-fatigue Floor Mat',
    description:
      'Standing-desk anti-fatigue mat. Polyurethane core, non-slip base, 24" × 36" × 0.75". Reduces leg/back strain on long standing days.',
    price: dec('49.00'),
    category: 'Office',
    tags: ['mat', 'standing-desk', 'office', 'anti-fatigue', 'polyurethane'],
    inventoryCount: 87,
    metadata: {
      dimensions_in: { width: 24, depth: 36, height: 0.75 },
      material: 'Polyurethane',
    },
  },
  {
    id: 'acc-lumbar-pillow',
    name: 'Memory Foam Lumbar Pillow',
    description:
      'Contoured memory-foam lumbar support pillow. Adjustable strap fits any office chair. Reduces lower-back pressure during long sits.',
    price: dec('39.00'),
    category: 'Office',
    tags: ['lumbar', 'pillow', 'memory-foam', 'office', 'accessory', 'back-support'],
    inventoryCount: 60,
    metadata: { material: 'Memory foam, breathable mesh cover' },
  },
];

// ════════════════════════════════════════════════════════════════════════════
// NUTRITION ACCESSORIES — bundleable with proteins
// ════════════════════════════════════════════════════════════════════════════

const NUTRITION_ACCESSORIES: SeedProduct[] = [
  {
    id: 'creatine-mono-500g',
    name: 'Creatine Monohydrate (Unflavored, 500g)',
    description:
      'Micronized creatine monohydrate. 5g per scoop, 100 servings, third-party tested for purity. Pairs with any protein.',
    price: dec('24.99'),
    category: 'Nutrition',
    tags: ['creatine', 'monohydrate', 'nutrition', 'unflavored', 'micronized', 'third-party-tested'],
    inventoryCount: 50,
    metadata: {
      serving_size_g: 5,
      servings: 100,
      nutrition_per_scoop: { calories: 0, creatine_monohydrate_g: 5 },
      ingredients: ['Creatine Monohydrate (Creapure®)'],
      certifications: ['Third-party tested', 'Banned-substance free'],
      use: 'Mix into water, juice, or any protein shake',
    },
  },
  {
    id: 'shaker-bottle-25oz',
    name: 'Premium Shaker Bottle (25oz)',
    description:
      '25oz BPA-free shaker bottle with stainless-steel BlenderBall, leak-proof flip cap, measurement markings.',
    price: dec('14.99'),
    category: 'Nutrition',
    tags: ['shaker', 'bottle', 'accessory', 'nutrition', 'bpa-free', 'leak-proof'],
    inventoryCount: 120,
    metadata: { capacity_oz: 25, material: 'BPA-free Tritan plastic, stainless-steel ball' },
  },
];

// ════════════════════════════════════════════════════════════════════════════
// PROTEINS (Nutrition) — type-aware generator
// ════════════════════════════════════════════════════════════════════════════
//
// PROTEIN_PROFILES holds a per-type "fingerprint" of a powder: how much
// protein it has per 100g of powder, its macronutrient cost (carbs/fat/
// cholesterol/sodium), and its amino-acid composition per 100g of pure
// protein. proteinProduct() then scales these to a real serving (scoop_g)
// and a real bottle size (size_lb), which keeps the maths consistent and
// the dataset truthful — no guessing per-product nutrition.
//
// Numbers below come from USDA + Examine.com + supplement industry COAs;
// rounded to 1 decimal for clarity. Per-100g-protein amino acid values are
// the right unit because protein concentration varies across types
// (isolate ~90%, concentrate ~75%, plant blends ~70%).

type ProteinType =
  | 'whey-isolate'
  | 'whey-concentrate'
  | 'whey-hydrolysate'
  | 'whey-native'
  | 'casein'
  | 'pea-isolate'
  | 'rice-isolate'
  | 'plant-blend'
  | 'egg-white';

interface AminoAcidProfile {
  leucine: number;
  isoleucine: number;
  valine: number;
  lysine: number;
  methionine: number;
  phenylalanine: number;
  threonine: number;
  tryptophan: number;
  histidine: number;
  arginine: number;
  alanine: number;
  aspartic_acid: number;
  cysteine: number;
  glutamic_acid: number;
  glycine: number;
  proline: number;
  serine: number;
  tyrosine: number;
}

interface ProteinProfile {
  display_name: string;
  source: string;
  is_vegan: boolean;
  filtration_method: string | null;
  digest_speed: 'fast' | 'medium' | 'slow';
  // Per 100g of powder
  protein_g_per_100g_powder: number;
  fat_g_per_100g_powder: number;
  saturated_fat_g_per_100g_powder: number;
  carbs_g_per_100g_powder: number;
  sugar_g_per_100g_powder: number;
  fiber_g_per_100g_powder: number;
  cholesterol_mg_per_100g_powder: number;
  sodium_mg_per_100g_powder: number;
  // Amino acids: g per 100g of PROTEIN (not powder)
  aa_per_100g_protein: AminoAcidProfile;
  // Notes
  glutamine_pct_of_protein: number; // estimate — for whey/casein high
  base_allergens: string[];
  base_certifications: string[];
}

const PROTEIN_PROFILES: Record<ProteinType, ProteinProfile> = {
  'whey-isolate': {
    display_name: 'Whey Protein Isolate',
    source: "Cow's milk (cross-flow microfiltered)",
    is_vegan: false,
    filtration_method: 'Cross-flow microfiltration',
    digest_speed: 'fast',
    protein_g_per_100g_powder: 90,
    fat_g_per_100g_powder: 1.5,
    saturated_fat_g_per_100g_powder: 0.8,
    carbs_g_per_100g_powder: 3,
    sugar_g_per_100g_powder: 1.5,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 18,
    sodium_mg_per_100g_powder: 200,
    aa_per_100g_protein: {
      leucine: 10.6, isoleucine: 6.0, valine: 5.8,
      lysine: 9.6, methionine: 2.4, phenylalanine: 3.0,
      threonine: 5.6, tryptophan: 2.0, histidine: 1.8,
      arginine: 2.4, alanine: 5.0, aspartic_acid: 11.0,
      cysteine: 2.0, glutamic_acid: 16.4, glycine: 1.7,
      proline: 5.5, serine: 4.8, tyrosine: 2.7,
    },
    glutamine_pct_of_protein: 16,
    base_allergens: ['Milk'],
    base_certifications: ['Grass-Fed', 'rBGH-Free', 'Non-GMO'],
  },
  'whey-concentrate': {
    display_name: 'Whey Protein Concentrate',
    source: "Cow's milk (ultrafiltered)",
    is_vegan: false,
    filtration_method: 'Ultrafiltration',
    digest_speed: 'fast',
    protein_g_per_100g_powder: 75,
    fat_g_per_100g_powder: 6,
    saturated_fat_g_per_100g_powder: 3.5,
    carbs_g_per_100g_powder: 9,
    sugar_g_per_100g_powder: 6,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 95,
    sodium_mg_per_100g_powder: 220,
    aa_per_100g_protein: {
      leucine: 10.4, isoleucine: 5.8, valine: 5.6,
      lysine: 9.0, methionine: 2.2, phenylalanine: 3.0,
      threonine: 5.4, tryptophan: 1.9, histidine: 1.7,
      arginine: 2.4, alanine: 4.9, aspartic_acid: 10.7,
      cysteine: 1.9, glutamic_acid: 16.0, glycine: 1.7,
      proline: 5.5, serine: 4.7, tyrosine: 2.6,
    },
    glutamine_pct_of_protein: 15,
    base_allergens: ['Milk'],
    base_certifications: ['Non-GMO'],
  },
  'whey-hydrolysate': {
    display_name: 'Hydrolyzed Whey Protein',
    source: "Cow's milk (enzymatically pre-digested)",
    is_vegan: false,
    filtration_method: 'Cross-flow microfiltration + enzymatic hydrolysis',
    digest_speed: 'fast',
    protein_g_per_100g_powder: 88,
    fat_g_per_100g_powder: 1.2,
    saturated_fat_g_per_100g_powder: 0.6,
    carbs_g_per_100g_powder: 2.5,
    sugar_g_per_100g_powder: 0.8,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 15,
    sodium_mg_per_100g_powder: 250,
    aa_per_100g_protein: {
      leucine: 10.7, isoleucine: 6.1, valine: 5.9,
      lysine: 9.6, methionine: 2.4, phenylalanine: 3.1,
      threonine: 5.6, tryptophan: 2.0, histidine: 1.8,
      arginine: 2.4, alanine: 5.0, aspartic_acid: 11.0,
      cysteine: 2.0, glutamic_acid: 16.5, glycine: 1.7,
      proline: 5.5, serine: 4.8, tyrosine: 2.7,
    },
    glutamine_pct_of_protein: 16,
    base_allergens: ['Milk'],
    base_certifications: ['Non-GMO'],
  },
  'whey-native': {
    display_name: 'Native Whey Isolate',
    source: 'Fresh raw cow milk (cold-processed, never pasteurized as cheese byproduct)',
    is_vegan: false,
    filtration_method: 'Cold cross-flow microfiltration of fresh milk',
    digest_speed: 'fast',
    protein_g_per_100g_powder: 92,
    fat_g_per_100g_powder: 1.0,
    saturated_fat_g_per_100g_powder: 0.5,
    carbs_g_per_100g_powder: 2,
    sugar_g_per_100g_powder: 1,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 12,
    sodium_mg_per_100g_powder: 180,
    aa_per_100g_protein: {
      leucine: 11.2, isoleucine: 6.4, valine: 6.1,
      lysine: 9.8, methionine: 2.5, phenylalanine: 3.1,
      threonine: 5.7, tryptophan: 2.1, histidine: 1.9,
      arginine: 2.4, alanine: 5.0, aspartic_acid: 11.1,
      cysteine: 2.1, glutamic_acid: 16.6, glycine: 1.7,
      proline: 5.5, serine: 4.8, tyrosine: 2.7,
    },
    glutamine_pct_of_protein: 17,
    base_allergens: ['Milk'],
    base_certifications: ['Grass-Fed', 'rBGH-Free', 'Non-GMO', 'Cold-Processed'],
  },
  casein: {
    display_name: 'Micellar Casein',
    source: "Cow's milk (acid-precipitated micellar casein)",
    is_vegan: false,
    filtration_method: 'Microfiltration',
    digest_speed: 'slow',
    protein_g_per_100g_powder: 80,
    fat_g_per_100g_powder: 2,
    saturated_fat_g_per_100g_powder: 1.2,
    carbs_g_per_100g_powder: 5,
    sugar_g_per_100g_powder: 3,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 30,
    sodium_mg_per_100g_powder: 320,
    aa_per_100g_protein: {
      leucine: 9.5, isoleucine: 5.7, valine: 6.3,
      lysine: 7.7, methionine: 2.7, phenylalanine: 5.1,
      threonine: 4.5, tryptophan: 1.4, histidine: 3.0,
      arginine: 3.7, alanine: 3.0, aspartic_acid: 7.2,
      cysteine: 0.4, glutamic_acid: 22.1, glycine: 1.8,
      proline: 11.8, serine: 5.7, tyrosine: 5.7,
    },
    glutamine_pct_of_protein: 22,
    base_allergens: ['Milk'],
    base_certifications: ['Non-GMO'],
  },
  'pea-isolate': {
    display_name: 'Pea Protein Isolate',
    source: 'Yellow pea (water-extracted, isolate)',
    is_vegan: true,
    filtration_method: 'Wet fractionation + isoelectric precipitation',
    digest_speed: 'medium',
    protein_g_per_100g_powder: 80,
    fat_g_per_100g_powder: 3,
    saturated_fat_g_per_100g_powder: 0.5,
    carbs_g_per_100g_powder: 6,
    sugar_g_per_100g_powder: 0,
    fiber_g_per_100g_powder: 4,
    cholesterol_mg_per_100g_powder: 0,
    sodium_mg_per_100g_powder: 670,
    aa_per_100g_protein: {
      leucine: 8.3, isoleucine: 4.6, valine: 5.0,
      lysine: 7.0, methionine: 1.0, phenylalanine: 5.2,
      threonine: 3.7, tryptophan: 0.8, histidine: 2.4,
      arginine: 8.4, alanine: 4.3, aspartic_acid: 11.4,
      cysteine: 0.5, glutamic_acid: 16.7, glycine: 4.0,
      proline: 4.4, serine: 5.0, tyrosine: 3.5,
    },
    glutamine_pct_of_protein: 9,
    base_allergens: [],
    base_certifications: ['Vegan', 'Non-GMO', 'Gluten-Free'],
  },
  'rice-isolate': {
    display_name: 'Brown Rice Protein Isolate',
    source: 'Sprouted brown rice (enzymatic extraction)',
    is_vegan: true,
    filtration_method: 'Enzymatic hydrolysis',
    digest_speed: 'medium',
    protein_g_per_100g_powder: 80,
    fat_g_per_100g_powder: 3,
    saturated_fat_g_per_100g_powder: 0.7,
    carbs_g_per_100g_powder: 6,
    sugar_g_per_100g_powder: 0,
    fiber_g_per_100g_powder: 1,
    cholesterol_mg_per_100g_powder: 0,
    sodium_mg_per_100g_powder: 130,
    aa_per_100g_protein: {
      leucine: 7.7, isoleucine: 4.0, valine: 5.4,
      lysine: 3.5, methionine: 2.4, phenylalanine: 5.0,
      threonine: 3.5, tryptophan: 1.0, histidine: 2.2,
      arginine: 8.0, alanine: 6.0, aspartic_acid: 9.0,
      cysteine: 1.6, glutamic_acid: 17.0, glycine: 4.1,
      proline: 4.5, serine: 5.0, tyrosine: 4.0,
    },
    glutamine_pct_of_protein: 10,
    base_allergens: [],
    base_certifications: ['Vegan', 'Non-GMO', 'Gluten-Free', 'Hypoallergenic'],
  },
  'plant-blend': {
    display_name: 'Plant Performance Blend',
    source: 'Pea + brown rice + hemp (synergistic blend, complete amino profile)',
    is_vegan: true,
    filtration_method: 'Multi-source isolate blend',
    digest_speed: 'medium',
    protein_g_per_100g_powder: 70,
    fat_g_per_100g_powder: 5,
    saturated_fat_g_per_100g_powder: 1,
    carbs_g_per_100g_powder: 12,
    sugar_g_per_100g_powder: 4,
    fiber_g_per_100g_powder: 4,
    cholesterol_mg_per_100g_powder: 0,
    sodium_mg_per_100g_powder: 560,
    aa_per_100g_protein: {
      leucine: 8.0, isoleucine: 4.3, valine: 5.2,
      lysine: 5.5, methionine: 1.8, phenylalanine: 5.0,
      threonine: 3.7, tryptophan: 1.0, histidine: 2.3,
      arginine: 8.2, alanine: 5.1, aspartic_acid: 10.2,
      cysteine: 1.0, glutamic_acid: 16.8, glycine: 4.0,
      proline: 4.5, serine: 5.0, tyrosine: 3.7,
    },
    glutamine_pct_of_protein: 9,
    base_allergens: [],
    base_certifications: ['Vegan', 'Non-GMO', 'Gluten-Free'],
  },
  'egg-white': {
    display_name: 'Egg White Protein',
    source: 'Pasteurized chicken egg whites (spray-dried)',
    is_vegan: false,
    filtration_method: 'Spray drying',
    digest_speed: 'medium',
    protein_g_per_100g_powder: 84,
    fat_g_per_100g_powder: 0.5,
    saturated_fat_g_per_100g_powder: 0,
    carbs_g_per_100g_powder: 4,
    sugar_g_per_100g_powder: 4,
    fiber_g_per_100g_powder: 0,
    cholesterol_mg_per_100g_powder: 0,
    sodium_mg_per_100g_powder: 1100,
    aa_per_100g_protein: {
      leucine: 8.6, isoleucine: 5.7, valine: 6.7,
      lysine: 6.3, methionine: 3.4, phenylalanine: 5.7,
      threonine: 4.4, tryptophan: 1.5, histidine: 2.4,
      arginine: 5.8, alanine: 6.3, aspartic_acid: 10.5,
      cysteine: 2.5, glutamic_acid: 13.5, glycine: 3.6,
      proline: 4.0, serine: 7.7, tyrosine: 4.0,
    },
    glutamine_pct_of_protein: 11,
    base_allergens: ['Egg'],
    base_certifications: ['Cage-Free'],
  },
};

interface ProteinSpec {
  id: string;
  type: ProteinType;
  flavor: string;
  size_lb: number;
  scoop_size_g: number; // typically 30g for isolate, 32-38g for concentrate/blend
  price: Prisma.Decimal;
  inventoryCount: number;
  extra_ingredients: string[]; // beyond the protein itself: flavors, sweeteners, etc.
  extra_allergens?: string[]; // e.g. soy lecithin
  extra_certifications?: string[];
}

function proteinProduct(spec: ProteinSpec): SeedProduct {
  const profile = PROTEIN_PROFILES[spec.type];
  const lbToG = 453.592;
  const weight_g = Math.round(spec.size_lb * lbToG);
  const servings = Math.floor(weight_g / spec.scoop_size_g);

  // Macros per scoop
  const protein_g = round1((profile.protein_g_per_100g_powder * spec.scoop_size_g) / 100);
  const fat_g = round1((profile.fat_g_per_100g_powder * spec.scoop_size_g) / 100);
  const sat_fat_g = round1((profile.saturated_fat_g_per_100g_powder * spec.scoop_size_g) / 100);
  const carbs_g = round1((profile.carbs_g_per_100g_powder * spec.scoop_size_g) / 100);
  const sugar_g = round1((profile.sugar_g_per_100g_powder * spec.scoop_size_g) / 100);
  const fiber_g = round1((profile.fiber_g_per_100g_powder * spec.scoop_size_g) / 100);
  const chol_mg = Math.round((profile.cholesterol_mg_per_100g_powder * spec.scoop_size_g) / 100);
  const sodium_mg = Math.round((profile.sodium_mg_per_100g_powder * spec.scoop_size_g) / 100);
  // Calories: protein 4 cal/g, carbs 4 cal/g, fat 9 cal/g
  const calories = Math.round(protein_g * 4 + carbs_g * 4 + fat_g * 9);

  // Amino acids per scoop = (per_100g_protein / 100) * protein_g
  const aaScale = protein_g / 100;
  const aas = profile.aa_per_100g_protein;
  const amino_acids_g = {
    leucine: round1(aas.leucine * aaScale),
    isoleucine: round1(aas.isoleucine * aaScale),
    valine: round1(aas.valine * aaScale),
    lysine: round1(aas.lysine * aaScale),
    methionine: round1(aas.methionine * aaScale),
    phenylalanine: round1(aas.phenylalanine * aaScale),
    threonine: round1(aas.threonine * aaScale),
    tryptophan: round1(aas.tryptophan * aaScale),
    histidine: round1(aas.histidine * aaScale),
    arginine: round1(aas.arginine * aaScale),
    alanine: round1(aas.alanine * aaScale),
    aspartic_acid: round1(aas.aspartic_acid * aaScale),
    cysteine: round1(aas.cysteine * aaScale),
    glutamic_acid: round1(aas.glutamic_acid * aaScale),
    glycine: round1(aas.glycine * aaScale),
    proline: round1(aas.proline * aaScale),
    serine: round1(aas.serine * aaScale),
    tyrosine: round1(aas.tyrosine * aaScale),
  };
  const total_bcaas_g = round1(amino_acids_g.leucine + amino_acids_g.isoleucine + amino_acids_g.valine);
  const total_eaas_g = round1(
    amino_acids_g.leucine + amino_acids_g.isoleucine + amino_acids_g.valine +
    amino_acids_g.lysine + amino_acids_g.methionine + amino_acids_g.phenylalanine +
    amino_acids_g.threonine + amino_acids_g.tryptophan + amino_acids_g.histidine,
  );
  const glutamine_g = round1((profile.glutamine_pct_of_protein * protein_g) / 100);

  const allergens = [...profile.base_allergens, ...(spec.extra_allergens ?? [])];
  const certifications = Array.from(
    new Set([...profile.base_certifications, ...(spec.extra_certifications ?? [])]),
  );

  // Concise phone-call description with the headline numbers
  const veganTag = profile.is_vegan ? 'Vegan, ' : '';
  const allergenTag = allergens.length === 0 ? 'allergen-free' : `contains ${allergens.join(', ').toLowerCase()}`;
  const description =
    `${profile.display_name} (${spec.flavor}, ${spec.size_lb}lb). ` +
    `${protein_g}g protein, ${total_bcaas_g}g BCAAs, ${sugar_g}g sugar, ${chol_mg}mg cholesterol, ${calories} cal per ${spec.scoop_size_g}g scoop. ` +
    `${servings} servings. ${veganTag}${allergenTag}.`;

  const tags = [
    spec.type, // e.g. 'whey-isolate', 'pea-isolate'
    'protein',
    'nutrition',
    spec.flavor.toLowerCase().replace(/\s+/g, '-'),
    `${spec.size_lb}lb`,
    `${protein_g}g-protein`,
    profile.digest_speed === 'fast'
      ? 'fast-digest'
      : profile.digest_speed === 'slow'
      ? 'slow-digest'
      : 'medium-digest',
    ...(profile.is_vegan ? ['vegan', 'plant-based'] : []),
    ...(allergens.length === 0 ? ['allergen-free'] : []),
  ];

  const ingredients = [profile.display_name, ...spec.extra_ingredients];

  const metadata: Prisma.InputJsonValue = {
    protein_type: spec.type,
    display_type: profile.display_name,
    source: profile.source,
    flavor: spec.flavor,
    size: { lb: spec.size_lb, g: weight_g },
    servings,
    scoop_size_g: spec.scoop_size_g,
    digest_speed: profile.digest_speed,
    filtration_method: profile.filtration_method,
    is_vegan: profile.is_vegan,
    nutrition_per_scoop: {
      serving_size_g: spec.scoop_size_g,
      calories,
      total_fat_g: fat_g,
      saturated_fat_g: sat_fat_g,
      trans_fat_g: 0,
      cholesterol_mg: chol_mg,
      sodium_mg,
      total_carbs_g: carbs_g,
      fiber_g,
      sugars_g: sugar_g,
      added_sugars_g: 0,
      protein_g,
    },
    amino_acid_profile_per_scoop_g: {
      ...amino_acids_g,
      total_bcaas: total_bcaas_g,
      total_eaas: total_eaas_g,
      glutamine_estimate: glutamine_g,
    },
    ingredients,
    allergens,
    certifications,
  };

  return {
    id: spec.id,
    name: `${profile.display_name} (${spec.flavor}, ${spec.size_lb}lb)`,
    description,
    price: spec.price,
    category: 'Nutrition',
    tags,
    inventoryCount: spec.inventoryCount,
    metadata,
  };
}

const PROTEIN_SPECS: ProteinSpec[] = [
  {
    id: 'whey-iso-vanilla',
    type: 'whey-isolate', flavor: 'Vanilla', size_lb: 2, scoop_size_g: 30,
    price: dec('59.99'), inventoryCount: 8,
    extra_ingredients: ['Natural Vanilla Flavor', 'Stevia Leaf Extract', 'Sea Salt'],
  },
  {
    id: 'whey-iso-choc',
    type: 'whey-isolate', flavor: 'Chocolate', size_lb: 2, scoop_size_g: 30,
    price: dec('59.99'), inventoryCount: 14,
    extra_ingredients: ['Cocoa Powder', 'Natural Chocolate Flavor', 'Stevia Leaf Extract', 'Sea Salt'],
  },
  {
    id: 'whey-conc-choc',
    type: 'whey-concentrate', flavor: 'Chocolate', size_lb: 5, scoop_size_g: 32,
    price: dec('44.99'), inventoryCount: 35,
    extra_ingredients: ['Cocoa Powder', 'Natural Flavors', 'Sucralose', 'Lecithin'],
    extra_allergens: ['Soy'],
  },
  {
    id: 'whey-conc-vanilla',
    type: 'whey-concentrate', flavor: 'Vanilla', size_lb: 5, scoop_size_g: 32,
    price: dec('42.99'), inventoryCount: 28,
    extra_ingredients: ['Natural Vanilla Flavor', 'Sucralose', 'Lecithin'],
    extra_allergens: ['Soy'],
  },
  {
    id: 'whey-perf-choc',
    type: 'whey-concentrate', flavor: 'Performance Chocolate', size_lb: 5, scoop_size_g: 34,
    price: dec('46.99'), inventoryCount: 22,
    extra_ingredients: [
      'Whey Protein Isolate (10% blend)', 'Cocoa Powder', 'Natural Flavors',
      'Creatine Monohydrate (1g)', 'L-Glutamine (500mg)', 'Sucralose', 'Lecithin',
    ],
    extra_allergens: ['Soy'],
  },
  {
    id: 'whey-hydro-unflav',
    type: 'whey-hydrolysate', flavor: 'Unflavored', size_lb: 2, scoop_size_g: 30,
    price: dec('74.99'), inventoryCount: 10,
    extra_ingredients: ['Sunflower Lecithin'],
  },
  {
    id: 'whey-native-vanilla',
    type: 'whey-native', flavor: 'Vanilla', size_lb: 2, scoop_size_g: 30,
    price: dec('69.99'), inventoryCount: 9,
    extra_ingredients: ['Natural Vanilla', 'Monk Fruit Extract', 'Sunflower Lecithin'],
  },
  {
    id: 'casein-choc',
    type: 'casein', flavor: 'Chocolate', size_lb: 2, scoop_size_g: 33,
    price: dec('54.99'), inventoryCount: 16,
    extra_ingredients: ['Cocoa Powder', 'Natural Chocolate Flavor', 'Stevia Leaf Extract', 'Sunflower Lecithin'],
  },
  {
    id: 'pea-iso-unflavored',
    type: 'pea-isolate', flavor: 'Unflavored', size_lb: 2, scoop_size_g: 30,
    price: dec('39.99'), inventoryCount: 45,
    extra_ingredients: [],
  },
  {
    id: 'rice-iso-vanilla',
    type: 'rice-isolate', flavor: 'Vanilla', size_lb: 2, scoop_size_g: 30,
    price: dec('34.99'), inventoryCount: 30,
    extra_ingredients: ['Natural Vanilla Flavor', 'Stevia Leaf Extract', 'Sea Salt'],
  },
  {
    id: 'plant-perf-berry',
    type: 'plant-blend', flavor: 'Mixed Berry', size_lb: 2, scoop_size_g: 32,
    price: dec('49.99'), inventoryCount: 5, // low for demo
    extra_ingredients: [
      'Pea Protein Isolate', 'Brown Rice Protein', 'Hemp Protein',
      'Natural Berry Flavor', 'Beet Root Powder (color)', 'Stevia Leaf Extract',
    ],
  },
  {
    id: 'egg-white-unflav',
    type: 'egg-white', flavor: 'Unflavored', size_lb: 2, scoop_size_g: 30,
    price: dec('44.99'), inventoryCount: 18,
    extra_ingredients: ['Sunflower Lecithin'],
  },
];

const PROTEINS: SeedProduct[] = PROTEIN_SPECS.map(proteinProduct);

// ════════════════════════════════════════════════════════════════════════════
// CLOTHES (Apparel) — variants per size
// ════════════════════════════════════════════════════════════════════════════

type ClothingBase = {
  baseId: string;
  baseName: string;
  description: string;
  price: Prisma.Decimal;
  tags: string[];
  color: string;
  material: string;
  care: string;
};

const CLOTHING_BASES: ClothingBase[] = [
  {
    baseId: 'cotton-tee',
    baseName: 'Premium Cotton Tee',
    description:
      'Heavyweight 220-GSM combed cotton tee. Pre-shrunk, double-stitched seams, ribbed crew neck. Holds shape after 50+ washes.',
    price: dec('29.00'),
    tags: ['tee', 'tshirt', 'cotton', 'apparel', 'casual', 'crew-neck', 'pre-shrunk'],
    color: 'Charcoal',
    material: '100% Combed Cotton, 220 GSM',
    care: 'Machine wash cold, tumble dry low',
  },
  {
    baseId: 'hoodie',
    baseName: 'Athletic Hoodie',
    description:
      'Mid-weight 320-GSM cotton/poly fleece hoodie. Kangaroo pocket, drawstring hood, ribbed cuffs. Breathable but warm.',
    price: dec('59.00'),
    tags: ['hoodie', 'fleece', 'apparel', 'athletic', 'pullover', 'kangaroo-pocket'],
    color: 'Navy',
    material: '80% Cotton / 20% Polyester Fleece, 320 GSM',
    care: 'Machine wash cold, tumble dry low, do not bleach',
  },
  {
    baseId: 'joggers',
    baseName: 'Tech Joggers',
    description:
      'Tapered tech-fabric joggers. 4-way stretch, zip side pockets, elasticated cuff. Gym-to-street.',
    price: dec('49.00'),
    tags: ['joggers', 'pants', 'apparel', 'tech-fabric', 'tapered', '4-way-stretch'],
    color: 'Black',
    material: '88% Polyester / 12% Spandex',
    care: 'Machine wash cold, hang dry',
  },
  {
    baseId: 'polo-tech',
    baseName: 'Tech Performance Polo',
    description:
      'Moisture-wicking tech polo. Anti-odor finish, UPF 30, 3-button placket, side vents. Smart-casual or course-ready.',
    price: dec('44.00'),
    tags: ['polo', 'apparel', 'tech-fabric', 'moisture-wicking', 'upf30', 'smart-casual'],
    color: 'Heather Grey',
    material: '92% Polyester / 8% Spandex, 160 GSM',
    care: 'Machine wash cold, tumble dry low',
  },
  {
    baseId: 'shorts-perf',
    baseName: 'Performance Training Shorts',
    description:
      'Lined 7-inch training shorts. 4-way stretch, zippered back pocket, drawstring waist, reflective trim. For lift, run, or court.',
    price: dec('34.00'),
    tags: ['shorts', 'apparel', 'training', 'tech-fabric', 'lined', 'reflective'],
    color: 'Black',
    material: '85% Polyester / 15% Spandex',
    care: 'Machine wash cold, hang dry',
  },
];

const SIZES: { size: string; inventoryCount: number }[] = [
  { size: 'S', inventoryCount: 18 },
  { size: 'M', inventoryCount: 32 },
  { size: 'L', inventoryCount: 25 },
  { size: 'XL', inventoryCount: 11 },
];

const CLOTHES: SeedProduct[] = CLOTHING_BASES.flatMap((base) =>
  SIZES.map((s) => ({
    id: `${base.baseId}-${s.size.toLowerCase()}`,
    name: `${base.baseName} (Size ${s.size}, ${base.color})`,
    description: `${base.description} Size ${s.size}, ${base.color}.`,
    price: base.price,
    category: 'Apparel',
    tags: [...base.tags, `size-${s.size.toLowerCase()}`, base.color.toLowerCase().replace(/\s+/g, '-')],
    inventoryCount: s.inventoryCount,
    metadata: {
      base_id: base.baseId,
      size: s.size,
      color: base.color,
      material: base.material,
      care_instructions: base.care,
    },
  })),
);

// ─── All products ──────────────────────────────────────────────────────────

const DEMO_PRODUCTS: SeedProduct[] = [
  ...CHAIRS,
  ...NUTRITION_ACCESSORIES,
  ...PROTEINS,
  ...CLOTHES,
];

// ════════════════════════════════════════════════════════════════════════════
// OFFERS — promotional rules attached to specific products
// ════════════════════════════════════════════════════════════════════════════
//
// Two types:
//   BUNDLE   — buy this primary product WITH `bundleProductId` → discount
//   QUANTITY — buy ≥ `minQuantity` of this primary product       → discount
//
// The agent retrieves these via the `get_available_offers(product_id)`
// observation tool and pitches them BEFORE escalating to a flat negotiation
// discount. That's the difference between a salesperson saying "fine, here's
// 5%" (desperate) and "if you grab the creatine too I can knock 5% off the
// whole order" (value-add).
//
// `discountPercent` here is independent of the 10% flat-discount cap; an
// offer can technically be 15% if the business wants. The 10% cap only
// applies to the agent's free-form negotiation discount.

type OfferType = 'BUNDLE' | 'QUANTITY';

interface SeedOffer {
  // Stable id so re-running the seed doesn't duplicate rows.
  id: string;
  productId: string;
  type: OfferType;
  description: string;
  shortPitch: string;
  discountPercent: number;
  bundleProductId?: string;
  minQuantity?: number;
}

const OFFERS: SeedOffer[] = [
  // ── Protein × Creatine bundles ─────────────────────────────────────────
  {
    id: 'offer-whey-iso-vanilla-creatine',
    productId: 'whey-iso-vanilla', type: 'BUNDLE',
    description: 'Bundle Whey Isolate Vanilla with Creatine Monohydrate for 5% off both items.',
    shortPitch: 'add the creatine and I can knock 5% off the whole order',
    discountPercent: 5, bundleProductId: 'creatine-mono-500g',
  },
  {
    id: 'offer-whey-iso-choc-creatine',
    productId: 'whey-iso-choc', type: 'BUNDLE',
    description: 'Bundle Whey Isolate Chocolate with Creatine Monohydrate for 5% off both items.',
    shortPitch: 'pair the creatine with it and I can take 5% off the cart',
    discountPercent: 5, bundleProductId: 'creatine-mono-500g',
  },
  {
    id: 'offer-whey-conc-choc-creatine',
    productId: 'whey-conc-choc', type: 'BUNDLE',
    description: 'Bundle Whey Concentrate Chocolate with Creatine for 5% off.',
    shortPitch: 'add a tub of creatine, that gets you 5% off the whole order',
    discountPercent: 5, bundleProductId: 'creatine-mono-500g',
  },
  {
    id: 'offer-whey-perf-choc-shaker',
    productId: 'whey-perf-choc', type: 'BUNDLE',
    description: 'Bundle Whey Performance with Premium Shaker Bottle for 5% off.',
    shortPitch: 'throw in a shaker and I can take 5% off',
    discountPercent: 5, bundleProductId: 'shaker-bottle-25oz',
  },
  {
    id: 'offer-casein-creatine',
    productId: 'casein-choc', type: 'BUNDLE',
    description: 'Bundle Micellar Casein with Creatine Monohydrate for 5% off.',
    shortPitch: 'casein plus creatine bundle gets you 5% off the order',
    discountPercent: 5, bundleProductId: 'creatine-mono-500g',
  },
  {
    id: 'offer-plant-perf-shaker',
    productId: 'plant-perf-berry', type: 'BUNDLE',
    description: 'Bundle Plant Performance with Premium Shaker for 5% off.',
    shortPitch: 'add a shaker bottle and that bumps you to 5% off',
    discountPercent: 5, bundleProductId: 'shaker-bottle-25oz',
  },

  // ── Protein QUANTITY offers ────────────────────────────────────────────
  {
    id: 'offer-whey-iso-vanilla-2x',
    productId: 'whey-iso-vanilla', type: 'QUANTITY',
    description: 'Buy 2 tubs of Whey Isolate Vanilla, get 10% off the order.',
    shortPitch: 'grab two tubs instead of one and that gets you 10% off',
    discountPercent: 10, minQuantity: 2,
  },
  {
    id: 'offer-whey-conc-choc-2x',
    productId: 'whey-conc-choc', type: 'QUANTITY',
    description: 'Buy 2× Whey Concentrate Chocolate (5lb each) for 10% off the order.',
    shortPitch: 'two of the 5-pounders bumps you to 10% off',
    discountPercent: 10, minQuantity: 2,
  },
  {
    id: 'offer-pea-iso-2x',
    productId: 'pea-iso-unflavored', type: 'QUANTITY',
    description: 'Buy 2 tubs of Pea Isolate, get 10% off the order.',
    shortPitch: 'two tubs of the pea isolate gets you 10% off',
    discountPercent: 10, minQuantity: 2,
  },

  // ── Office bundles ─────────────────────────────────────────────────────
  {
    id: 'offer-prod-001-mat',
    productId: 'prod-001', type: 'BUNDLE',
    description: 'Bundle ZephyrChair Pro with Anti-fatigue Mat for 5% off both.',
    shortPitch: 'add the anti-fatigue mat and I can take 5% off the whole setup',
    discountPercent: 5, bundleProductId: 'acc-mat-01',
  },
  {
    id: 'offer-prod-001-lumbar',
    productId: 'prod-001', type: 'BUNDLE',
    description: 'Bundle ZephyrChair Pro with Lumbar Pillow for 5% off.',
    shortPitch: 'pair it with the lumbar pillow, that\'s 5% off the order',
    discountPercent: 5, bundleProductId: 'acc-lumbar-pillow',
  },
  {
    id: 'offer-prod-002-mat',
    productId: 'prod-002', type: 'BUNDLE',
    description: 'Bundle ZephyrChair Lite with Anti-fatigue Mat for 5% off.',
    shortPitch: 'mat plus chair gets you 5% off',
    discountPercent: 5, bundleProductId: 'acc-mat-01',
  },
  {
    id: 'offer-gamethrone-mat',
    productId: 'chair-gamethrone', type: 'BUNDLE',
    description: 'Bundle GameThrone with Anti-fatigue Mat for 5% off.',
    shortPitch: 'add the mat and that\'s 5% off the cart',
    discountPercent: 5, bundleProductId: 'acc-mat-01',
  },
  {
    id: 'offer-executive-lumbar',
    productId: 'chair-executive', type: 'BUNDLE',
    description: 'Bundle Executive Chair with Lumbar Pillow for 5% off.',
    shortPitch: 'lumbar pillow added, that brings 5% off',
    discountPercent: 5, bundleProductId: 'acc-lumbar-pillow',
  },

  // ── Apparel bundles + quantity ────────────────────────────────────────
  // Hoodie + Joggers per matching size
  ...['s', 'm', 'l', 'xl'].map((size) => ({
    id: `offer-hoodie-joggers-${size}`,
    productId: `hoodie-${size}`, type: 'BUNDLE' as OfferType,
    description: `Bundle Athletic Hoodie (size ${size.toUpperCase()}) with Tech Joggers for 10% off.`,
    shortPitch: 'grab the matching joggers and that\'s 10% off the set',
    discountPercent: 10, bundleProductId: `joggers-${size}`,
  })),
  // Polo + shorts per matching size
  ...['s', 'm', 'l', 'xl'].map((size) => ({
    id: `offer-polo-shorts-${size}`,
    productId: `polo-tech-${size}`, type: 'BUNDLE' as OfferType,
    description: `Bundle Tech Polo (size ${size.toUpperCase()}) with Performance Shorts for 10% off.`,
    shortPitch: 'add the matching shorts, you get 10% off',
    discountPercent: 10, bundleProductId: `shorts-perf-${size}`,
  })),
  // Cotton tee 2-pack
  ...['s', 'm', 'l', 'xl'].map((size) => ({
    id: `offer-tee-2x-${size}`,
    productId: `cotton-tee-${size}`, type: 'QUANTITY' as OfferType,
    description: `Buy 2 Premium Cotton Tees (size ${size.toUpperCase()}) for 10% off.`,
    shortPitch: 'two-pack instead of one is 10% off',
    discountPercent: 10, minQuantity: 2,
  })),
];

// ════════════════════════════════════════════════════════════════════════════
// REVIEWS
// ════════════════════════════════════════════════════════════════════════════

const REVIEWS: { productId: string; rating: number; body: string; helpful: number }[] = [
  // ── Chairs ────────────────────────────────────────────────────────────
  { productId: 'prod-001', rating: 5, body: 'Best chair I have ever owned. Lumbar support is incredible, no more lower back pain after 8-hour days.', helpful: 142 },
  { productId: 'prod-001', rating: 5, body: 'Worth every penny. Assembly took 20 min, mesh stays cool, recline is buttery.', helpful: 89 },
  { productId: 'prod-001', rating: 4, body: 'Excellent build but expected the armrests to have more travel range.', helpful: 31 },
  { productId: 'prod-001', rating: 5, body: 'Coming from a $2k Herman Miller and honestly prefer this one.', helpful: 76 },
  { productId: 'prod-001', rating: 2, body: 'Seat cushion compressed too quickly for a chair at this price point.', helpful: 18 },
  { productId: 'prod-001', rating: 5, body: 'Five-year warranty got honored when my caster broke. Customer service was painless.', helpful: 54 },

  { productId: 'prod-002', rating: 4, body: 'Good chair for the price. Lumbar adjustment is more limited than the Pro but still helps.', helpful: 64 },
  { productId: 'prod-002', rating: 5, body: 'Bought this instead of the Pro and have zero regrets. Plenty of chair for under $200.', helpful: 95 },
  { productId: 'prod-002', rating: 3, body: 'Decent, but the mesh feels thinner than I expected.', helpful: 12 },
  { productId: 'prod-002', rating: 4, body: 'Solid value pick. Use it for 6+ hours daily.', helpful: 41 },

  { productId: 'chair-gamethrone', rating: 5, body: 'Recline is amazing for between-match naps. Headrest pillow actually fits an adult head.', helpful: 78 },
  { productId: 'chair-gamethrone', rating: 4, body: 'Comfortable for long streams. RGB stitching is more subtle than I expected, which I like.', helpful: 33 },
  { productId: 'chair-gamethrone', rating: 5, body: 'Switched from a DXRacer and the build quality is noticeably better at the same price.', helpful: 52 },
  { productId: 'chair-gamethrone', rating: 2, body: 'Lumbar pillow strap broke after 3 weeks. Got a replacement under warranty but annoying.', helpful: 19 },

  { productId: 'chair-executive', rating: 5, body: 'Genuine top-grain leather, holds shape. Worth the premium for a client-facing office.', helpful: 47 },
  { productId: 'chair-executive', rating: 4, body: 'Beautiful chair, but the headrest is non-adjustable. Tall users might find it short.', helpful: 22 },
  { productId: 'chair-executive', rating: 5, body: 'Replaced a $1500 Steelcase with this. Honestly more comfortable.', helpful: 35 },

  { productId: 'chair-mesh-task', rating: 4, body: 'Solid entry-level chair. No frills but surprisingly comfortable for the price.', helpful: 88 },
  { productId: 'chair-mesh-task', rating: 3, body: 'Tilt knob is stiff. Mesh is thin. Fine for occasional use.', helpful: 26 },
  { productId: 'chair-mesh-task', rating: 5, body: 'Bought 4 for the team. No complaints in 6 months.', helpful: 51 },

  { productId: 'chair-kneeling', rating: 5, body: 'Took 2 weeks to adapt but my lower back pain is gone. Game changer.', helpful: 64 },
  { productId: 'chair-kneeling', rating: 3, body: 'Helpful for short stints, but I rotate it with a normal chair. Hard to do 8h on this alone.', helpful: 29 },

  { productId: 'chair-saddle-stool', rating: 5, body: 'My dental hygienist recommended this. Posture improved noticeably.', helpful: 38 },
  { productId: 'chair-saddle-stool', rating: 4, body: 'Pneumatic lift is smooth, casters lock cleanly. Saddle takes a week to get used to.', helpful: 21 },

  { productId: 'acc-mat-01', rating: 5, body: 'Saved my knees from standing-desk hell.', helpful: 23 },
  { productId: 'acc-mat-01', rating: 4, body: 'Comfortable but slightly thinner than competitors. Good price though.', helpful: 9 },

  // ── Proteins ──────────────────────────────────────────────────────────
  { productId: 'whey-iso-vanilla', rating: 5, body: 'Mixes clean even in cold water, no clumping. Vanilla is subtle, not artificial.', helpful: 64 },
  { productId: 'whey-iso-vanilla', rating: 5, body: 'Lactose-free claim is real — no GI issues for me where other whey kills me.', helpful: 88 },
  { productId: 'whey-iso-vanilla', rating: 4, body: 'Good protein-to-calorie ratio. Wish it came in a 5lb option.', helpful: 22 },
  { productId: 'whey-iso-vanilla', rating: 3, body: 'Solid quality but pricey vs. the performance blend.', helpful: 14 },

  { productId: 'whey-iso-choc', rating: 5, body: 'Chocolate flavor without the chalky aftertaste. Stevia is dialed in well.', helpful: 41 },
  { productId: 'whey-iso-choc', rating: 4, body: 'Great isolate. Mixes a hair clumpier than the vanilla version.', helpful: 18 },

  { productId: 'whey-conc-choc', rating: 5, body: 'Chocolate flavor is genuinely good — tastes like chocolate milk, not chalky.', helpful: 92 },
  { productId: 'whey-conc-choc', rating: 5, body: 'Best per-serving cost in the bracket. Have been buying this for 2 years.', helpful: 71 },
  { productId: 'whey-conc-choc', rating: 4, body: 'Mixes well with milk, slightly clumpy in water. Worth it for the price.', helpful: 28 },
  { productId: 'whey-conc-choc', rating: 2, body: 'Sucralose aftertaste hits hard for me. Not for everyone.', helpful: 33 },

  { productId: 'whey-conc-vanilla', rating: 4, body: 'Cleaner vanilla than the chocolate variant. Decent value.', helpful: 25 },
  { productId: 'whey-conc-vanilla', rating: 5, body: 'My go-to baking protein — survives oven heat, doesn\'t affect texture.', helpful: 42 },

  { productId: 'whey-perf-choc', rating: 5, body: 'The added creatine + glutamine makes a real difference post-workout. Saves me buying separately.', helpful: 67 },
  { productId: 'whey-perf-choc', rating: 4, body: 'Strong chocolate flavor. Mixing instructions matter — too much water and it clumps.', helpful: 31 },

  { productId: 'whey-hydro-unflav', rating: 5, body: 'Hits faster than regular isolate, no bloat. Pricey but the difference is real.', helpful: 54 },
  { productId: 'whey-hydro-unflav', rating: 3, body: 'Does the job but the bitter aftertaste is rough unflavored. Mix with something.', helpful: 19 },
  { productId: 'whey-hydro-unflav', rating: 4, body: 'Genuinely lactose-friendly for those of us with dairy issues.', helpful: 38 },

  { productId: 'whey-native-vanilla', rating: 5, body: 'Tastes lighter than regular whey isolate. You can tell it is processed less.', helpful: 47 },
  { productId: 'whey-native-vanilla', rating: 4, body: 'Premium product, premium price. Worth it as a daily if budget allows.', helpful: 22 },

  { productId: 'casein-choc', rating: 5, body: 'Pre-bed shake game changed. Stays full overnight, no early morning hunger.', helpful: 58 },
  { productId: 'casein-choc', rating: 4, body: 'Thick when blended — pudding consistency. Some love it, I had to thin it down.', helpful: 26 },
  { productId: 'casein-choc', rating: 3, body: 'Slow digesting as advertised. Chocolate flavor is just OK.', helpful: 14 },

  { productId: 'pea-iso-unflavored', rating: 5, body: 'Unflavored is exactly that — neutral, blends into smoothies without changing taste.', helpful: 56 },
  { productId: 'pea-iso-unflavored', rating: 4, body: 'Good vegan option. Slightly grainier than whey but expected.', helpful: 38 },
  { productId: 'pea-iso-unflavored', rating: 3, body: 'Works fine but the sodium is higher than I would like (200mg per serving).', helpful: 17 },

  { productId: 'rice-iso-vanilla', rating: 4, body: 'Hypoallergenic claim is real — no issues for my milk-and-soy-allergic kid.', helpful: 33 },
  { productId: 'rice-iso-vanilla', rating: 3, body: 'Lower lysine than whey/pea. I stack it with pea protein to round out aminos.', helpful: 21 },

  { productId: 'plant-perf-berry', rating: 5, body: 'Berry flavor is natural, not candy-sweet. Complete amino profile makes this my daily.', helpful: 47 },
  { productId: 'plant-perf-berry', rating: 4, body: 'Nice blend, mixes well. Wish protein content were closer to 25g.', helpful: 21 },

  { productId: 'egg-white-unflav', rating: 4, body: 'Best amino profile of any protein I track. Sodium is high though.', helpful: 36 },
  { productId: 'egg-white-unflav', rating: 3, body: 'Foams a lot when shaken. Let it sit for a minute before drinking.', helpful: 12 },

  // ── Apparel ──────────────────────────────────────────────────────────
  { productId: 'cotton-tee-m', rating: 5, body: 'Heavyweight feel, holds shape after 30+ washes. The 220 GSM claim is real.', helpful: 53 },
  { productId: 'cotton-tee-m', rating: 5, body: 'Best fitted tee I have bought under $30. Charcoal is a true charcoal, not faded.', helpful: 41 },
  { productId: 'cotton-tee-m', rating: 4, body: 'Slightly tight in the shoulders for a regular fit — size up if you lift.', helpful: 29 },
  { productId: 'cotton-tee-l', rating: 4, body: 'Runs slightly small. Comfortable but L fits like a typical M.', helpful: 18 },

  { productId: 'hoodie-m', rating: 5, body: 'Warm without being heavy. Kangaroo pocket is deep enough for a phone + wallet.', helpful: 67 },
  { productId: 'hoodie-m', rating: 5, body: 'Drawstrings are sturdy, hood actually fits over a hat.', helpful: 39 },
  { productId: 'hoodie-l', rating: 4, body: 'Great hoodie. Cuff stretched out a bit after 6 months.', helpful: 22 },
  { productId: 'hoodie-xl', rating: 4, body: 'Roomy XL. Material feels premium for the price.', helpful: 14 },

  { productId: 'joggers-m', rating: 5, body: '4-way stretch is real — can squat in these. Pockets are zippered, phone stays put.', helpful: 58 },
  { productId: 'joggers-m', rating: 4, body: 'Tapered fit is on point. Cuff is a bit tight for ankle socks.', helpful: 24 },
  { productId: 'joggers-l', rating: 5, body: 'Gym-to-street as advertised. Wear them more than my old joggers and chinos combined.', helpful: 31 },

  { productId: 'polo-tech-m', rating: 5, body: 'Anti-odor actually works. Played 18 holes, drove home, no smell.', helpful: 43 },
  { productId: 'polo-tech-l', rating: 4, body: 'Smart-casual works for office and weekend. Heather grey hides sweat well.', helpful: 27 },

  { productId: 'shorts-perf-m', rating: 5, body: 'Liner is comfortable for unlined-haters like me. Zippered pocket is the win.', helpful: 51 },
  { productId: 'shorts-perf-l', rating: 4, body: 'Reflective trim is subtle but visible at night. Solid running shorts.', helpful: 23 },
];

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ════════════════════════════════════════════════════════════════════════════

const CUSTOMERS = [
  {
    phone: '+15551234567', name: 'Sarah Chen', email: 'sarah.chen@example.com',
    segment: CustomerSegment.RETURNING, timezone: 'America/Los_Angeles', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 60 },
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 200 },
    ],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }, { productId: 'acc-mat-01', quantity: 1 }],
  },
  {
    phone: '+15552223333', name: 'Marcus Reyes', email: 'marcus@example.com',
    segment: CustomerSegment.VIP, timezone: 'America/New_York', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'prod-001', price: dec('349.00'), daysAgo: 15 },
      { productId: 'prod-002', price: dec('199.00'), daysAgo: 90 },
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 95 },
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 30 },
    ],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }],
  },
  {
    phone: '+15553334444', name: 'Priya Patel', email: 'priya.p@example.com',
    segment: CustomerSegment.FIRST_TIME, timezone: 'America/Chicago', preferredContact: 'email',
    priorOrders: [],
    abandonedCart: [{ productId: 'prod-001', quantity: 1 }],
  },
  {
    phone: '+15554445555', name: 'James Kowalski', email: 'jkowalski@example.com',
    segment: CustomerSegment.LAPSED, timezone: 'America/Denver', preferredContact: 'phone',
    priorOrders: [
      { productId: 'prod-002', price: dec('199.00'), daysAgo: 280 },
    ],
    abandonedCart: [{ productId: 'prod-002', quantity: 1 }],
  },
  {
    phone: '+15555556666', name: 'Aisha Mohamed', email: 'aisha@example.com',
    segment: CustomerSegment.RETURNING, timezone: 'America/Los_Angeles', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'whey-iso-vanilla', price: dec('59.99'), daysAgo: 45 },
      { productId: 'whey-iso-vanilla', price: dec('59.99'), daysAgo: 80 },
    ],
    abandonedCart: [{ productId: 'whey-iso-vanilla', quantity: 1 }],
  },
  {
    phone: '+15556667777', name: 'Ben Thompson', email: null,
    segment: CustomerSegment.FIRST_TIME, timezone: null, preferredContact: null,
    priorOrders: [],
    abandonedCart: [{ productId: 'cotton-tee-m', quantity: 2 }],
  },
  {
    phone: '+15557778888', name: 'Elena Petrov', email: 'elena.p@example.com',
    segment: CustomerSegment.VIP, timezone: 'Europe/London', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'prod-001', price: dec('349.00'), daysAgo: 10 },
      { productId: 'prod-001', price: dec('349.00'), daysAgo: 180 },
      { productId: 'prod-002', price: dec('199.00'), daysAgo: 220 },
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 12 },
      { productId: 'acc-mat-01', price: dec('49.00'), daysAgo: 14 },
    ],
    abandonedCart: [
      { productId: 'prod-001', quantity: 1 },
      { productId: 'acc-mat-01', quantity: 1 },
    ],
  },
  {
    phone: '+15558889999', name: 'David Park', email: 'davidpark@example.com',
    segment: CustomerSegment.RETURNING, timezone: 'America/Los_Angeles', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'whey-perf-choc', price: dec('46.99'), daysAgo: 35 },
      { productId: 'whey-perf-choc', price: dec('46.99'), daysAgo: 95 },
    ],
    abandonedCart: [{ productId: 'plant-perf-berry', quantity: 1 }],
  },
  {
    phone: '+15559990000', name: 'Liam Walsh', email: 'liam@example.com',
    segment: CustomerSegment.FIRST_TIME, timezone: 'America/New_York', preferredContact: 'whatsapp',
    priorOrders: [],
    abandonedCart: [
      { productId: 'hoodie-l', quantity: 1 },
      { productId: 'joggers-l', quantity: 1 },
    ],
  },
  {
    phone: '+15550001111', name: 'Maya Singh', email: 'maya.s@example.com',
    segment: CustomerSegment.VIP, timezone: 'America/Los_Angeles', preferredContact: 'whatsapp',
    priorOrders: [
      { productId: 'whey-iso-vanilla', price: dec('59.99'), daysAgo: 8 },
      { productId: 'casein-choc', price: dec('54.99'), daysAgo: 25 },
      { productId: 'whey-perf-choc', price: dec('46.99'), daysAgo: 75 },
      { productId: 'plant-perf-berry', price: dec('49.99'), daysAgo: 120 },
    ],
    abandonedCart: [{ productId: 'whey-hydro-unflav', quantity: 1 }],
  },
];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

async function seedProducts() {
  for (const p of DEMO_PRODUCTS) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        tags: p.tags,
        isActive: true,
        inventoryCount: p.inventoryCount,
        restockEta: null,
        stockUpdatedAt: new Date(),
        ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
      },
      create: {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        tags: p.tags,
        isActive: true,
        inventoryCount: p.inventoryCount,
        restockEta: null,
        stockUpdatedAt: new Date(),
        ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
      },
    });
  }
  console.log(`✓ ${DEMO_PRODUCTS.length} products upserted`);
}

async function seedReviews() {
  for (const productId of DEMO_PRODUCTS.map((p) => p.id)) {
    await prisma.productReview.deleteMany({ where: { productId } });
  }
  for (const r of REVIEWS) {
    await prisma.productReview.create({ data: r });
  }
  console.log(`✓ ${REVIEWS.length} reviews seeded`);
}

async function seedOffers() {
  // Skip any offer whose primary product (or bundle product, if BUNDLE) is
  // not in the seed — keeps the seed forward-compatible and avoids FK errors.
  const seededIds = new Set(DEMO_PRODUCTS.map((p) => p.id));
  let upserted = 0;
  let skipped = 0;
  for (const offer of OFFERS) {
    if (!seededIds.has(offer.productId)) { skipped++; continue; }
    if (offer.type === 'BUNDLE' && offer.bundleProductId && !seededIds.has(offer.bundleProductId)) {
      skipped++; continue;
    }
    await prisma.offer.upsert({
      where: { id: offer.id },
      update: {
        productId: offer.productId,
        type: offer.type,
        description: offer.description,
        shortPitch: offer.shortPitch,
        discountPercent: offer.discountPercent,
        bundleProductId: offer.bundleProductId ?? null,
        minQuantity: offer.minQuantity ?? null,
        isActive: true,
      },
      create: {
        id: offer.id,
        productId: offer.productId,
        type: offer.type,
        description: offer.description,
        shortPitch: offer.shortPitch,
        discountPercent: offer.discountPercent,
        bundleProductId: offer.bundleProductId ?? null,
        minQuantity: offer.minQuantity ?? null,
      },
    });
    upserted++;
  }
  console.log(`✓ ${upserted} offers upserted${skipped > 0 ? ` (${skipped} skipped — referenced products not in seed)` : ''}`);
}

async function seedCustomers() {
  let total = 0;
  let totalPurchases = 0;
  let totalCarts = 0;
  for (const c of CUSTOMERS) {
    let ltv = new Prisma.Decimal(0);
    for (const o of c.priorOrders) ltv = ltv.add(o.price);
    const customer = await prisma.customer.upsert({
      where: { phone: c.phone },
      update: {
        name: c.name,
        email: c.email,
        segment: c.segment,
        lifetimeValue: ltv,
        timezone: c.timezone,
        preferredContact: c.preferredContact,
      },
      create: {
        phone: c.phone,
        name: c.name,
        email: c.email,
        segment: c.segment,
        lifetimeValue: ltv,
        timezone: c.timezone,
        preferredContact: c.preferredContact,
      },
    });
    total++;

    await prisma.purchase.deleteMany({ where: { customerId: customer.id } });
    for (const order of c.priorOrders) {
      await prisma.purchase.create({
        data: {
          customerId: customer.id,
          productId: order.productId,
          price: order.price,
          quantity: 1,
          purchasedAt: daysAgo(order.daysAgo),
        },
      });
      totalPurchases++;
    }

    await prisma.cart.deleteMany({ where: { customerId: customer.id } });
    if (c.abandonedCart.length > 0) {
      const cart = await prisma.cart.create({
        data: {
          customerId: customer.id,
          status: CartStatus.ABANDONED,
          abandonedAt: minutesAgo(15 + Math.floor(Math.random() * 60)),
          items: {
            create: c.abandonedCart.map((item) => {
              const product = DEMO_PRODUCTS.find((p) => p.id === item.productId);
              if (!product) throw new Error(`unknown product ${item.productId}`);
              return {
                productId: item.productId,
                priceAtAdd: product.price,
                quantity: item.quantity,
              };
            }),
          },
        },
      });
      totalCarts++;
      void cart;
    }
  }
  console.log(`✓ ${total} customers, ${totalPurchases} purchases, ${totalCarts} abandoned carts`);
}

async function main() {
  console.log('Seeding demo data...');
  await seedProducts();
  await seedReviews();
  await seedCustomers();
  await seedOffers();

  console.log('\nSummary:');
  const [productCount, customerCount, cartCount, purchaseCount, reviewCount, offerCount] = await Promise.all([
    prisma.product.count({ where: { isActive: true } }),
    prisma.customer.count(),
    prisma.cart.count({ where: { status: CartStatus.ABANDONED } }),
    prisma.purchase.count(),
    prisma.productReview.count(),
    prisma.offer.count({ where: { isActive: true } }),
  ]);
  console.log(`  active products:   ${productCount}`);
  console.log(`  customers:         ${customerCount}`);
  console.log(`  abandoned carts:   ${cartCount}`);
  console.log(`  purchases:         ${purchaseCount}`);
  console.log(`  reviews:           ${reviewCount}`);
  console.log(`  active offers:     ${offerCount}`);

  console.log('\nProduct mix by category:');
  const byCategory = await prisma.product.groupBy({
    by: ['category'],
    where: { isActive: true },
    _count: { id: true },
  });
  for (const c of byCategory) {
    console.log(`  ${c.category ?? '(uncategorized)'}: ${c._count.id}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
