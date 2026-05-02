-- CreateEnum
CREATE TYPE "OfferType" AS ENUM ('BUNDLE', 'QUANTITY');

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "type" "OfferType" NOT NULL,
    "description" TEXT NOT NULL,
    "short_pitch" TEXT NOT NULL,
    "discount_percent" INTEGER NOT NULL,
    "bundle_product_id" TEXT,
    "min_quantity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offers_product_id_is_active_idx" ON "offers"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "offers_type_is_active_idx" ON "offers"("type", "is_active");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_bundle_product_id_fkey" FOREIGN KEY ("bundle_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
