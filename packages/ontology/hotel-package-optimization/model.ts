import { z } from 'zod';
import { currentKernelImplementation } from '../definition-store.js';
import { OntologyModel, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition } from '../model.js';
import { text, requestSchema, skuSchema, componentSchema, quoteSchema, inventorySchema, entitlementSchema, resourceSchema, prerequisiteSchema } from './contracts.js';

export const PACKAGE_STUDY_ONTOLOGY = 'eigos.synthetic.hotel-packages';
export const PACKAGE_STUDY_FUNCTION = 'optimizeSyntheticHotelPackages';
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType): PropertyDefinition => ({kind,schema,required:true,description:'Explicit synthetic domain fact; never provider evidence or execution authority',source:'Synthetic hotel-package optimization study'});
const object = (id: string, data: z.ZodType): ObjectTypeDefinition => ({id,version:'1',name:id,aliases:[id],description:'Synthetic package domain object; not part of the active production kernel',primaryKey:'id',titleKey:'displayTitle',properties:{id:p('string',text),displayTitle:p('string',text),data:p('struct',data)}});
const objects = [
  object('HotelPackageStudy',z.strictObject({datasetId:text,evidenceLevel:z.literal('synthetic'),completeness:z.enum(['complete','partial'])})),
  object('HotelPackageRequest',requestSchema), object('PackageProduct',z.strictObject({sourceProductId:text})),
  object('PackageSkuSpecification',skuSchema), object('PackageComponent',componentSchema), object('PackageDatedQuote',quoteSchema),
  object('PackageInventoryPool',inventorySchema), object('PackageEntitlement',entitlementSchema),
  object('PackageResourceUse',resourceSchema), object('PackagePrerequisite',prerequisiteSchema),
];
const link = (id: string, from: string, name: string, to: string, reverse: string, many=true, required=false): LinkDefinition => ({id,description:'Explicit synthetic package relationship',from:{type:from,name,many,required},to:{type:to,name:reverse,many:true}});
export const packageStudyLinks = [
  link('PackageRequestStudy','HotelPackageRequest','study','HotelPackageStudy','requests',false,true),
  link('PackageRequestHotel','HotelPackageRequest','hotel','HotelProperty','packageStudies',false,true),
  link('PackageRequestRoomTypes','HotelPackageRequest','roomTypes','RoomType','packageStudies'),
  link('PackageStudySkus','HotelPackageStudy','skus','PackageSkuSpecification','studies'),
  link('PackageStudyQuotes','HotelPackageStudy','quotes','PackageDatedQuote','studies'),
  link('PackageStudyPools','HotelPackageStudy','pools','PackageInventoryPool','studies'),
  link('PackageStudyEntitlements','HotelPackageStudy','entitlements','PackageEntitlement','studies'),
  link('PackageStudyProducts','HotelPackageStudy','products','PackageProduct','studies'),
  link('PackageSkuVariant','PackageSkuSpecification','variant','ProductVariant','packageSpecifications',false,true),
  link('PackageVariantProduct','ProductVariant','packageProduct','PackageProduct','variants',false),
  link('PackageSkuComponents','PackageSkuSpecification','components','PackageComponent','skus'),
  link('PackageSkuPrerequisites','PackageSkuSpecification','prerequisites','PackagePrerequisite','dependants'),
  link('PackagePrerequisiteSku','PackagePrerequisite','sku','PackageSkuSpecification','prerequisiteUses',false,true),
  link('PackageComponentRoomTypes','PackageComponent','roomTypes','RoomType','packageComponents'),
  link('PackageComponentRatePlan','PackageComponent','ratePlan','HotelRatePlan','packageComponents',false),
  link('PackageComponentEntitlement','PackageComponent','entitlement','PackageEntitlement','packageComponents',false),
  link('PackageQuoteSku','PackageDatedQuote','sku','PackageSkuSpecification','quotes',false,true),
  link('PackageQuoteRoomType','PackageDatedQuote','roomType','RoomType','packageQuotes',false),
  link('PackageQuoteUses','PackageDatedQuote','resourceUses','PackageResourceUse','quotes'),
  link('PackageUsePool','PackageResourceUse','pool','PackageInventoryPool','uses',false,true),
  link('PackageUseComponent','PackageResourceUse','component','PackageComponent','resourceUses',false),
  link('PackagePoolRoomTypes','PackageInventoryPool','roomTypes','RoomType','packagePools'),
  link('PackagePoolEntitlement','PackageInventoryPool','entitlement','PackageEntitlement','pools',false),
  link('PackagePoolSkus','PackageInventoryPool','skus','PackageSkuSpecification','inventoryPools'),
];
let cached: OntologyModel | undefined;
/** Local test-model extension only. No kernel version change, namespace
 * publication, activation, source access or production migration occurs. */
export function createPackageStudyModel(): OntologyModel {
  if (!cached) {
    const base=currentKernelImplementation().definitionSnapshot();
    cached=new OntologyModel({...base,id:PACKAGE_STUDY_ONTOLOGY,version:'1',objects:[...base.objects,...objects],links:[...base.links,...packageStudyLinks],functions:[...base.functions,{id:PACKAGE_STUDY_FUNCTION,version:'1',inputTypes:['HotelPackageRequest'],description:'Read-only bounded price and composition-path optimization over explicit synthetic facts; not bookability or authorization'}]});
  }
  return cached;
}
