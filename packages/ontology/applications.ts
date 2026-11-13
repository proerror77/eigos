import type { OntologyDocument } from './schema.js';

const text = {type:'string'};
const point = {type:'array',items:{type:'number'},minItems:3,maxItems:3};
const reference = {type:'object',properties:{type:text,id:text},required:['type','id'],additionalProperties:false};
const parameters = (properties:Record<string,unknown>,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const properties = (fields:Record<string,[string,Record<string,unknown>]>) => Object.fromEntries(Object.entries(fields).map(([name,[description,schema]])=>[name,{description,schema,required:true}]));
const assetInput=parameters({id:text,name:text,format:{type:'string',enum:['glb','gltf','obj','stl','ply']},contentHash:text,byteLength:{type:'integer',minimum:1},units:text});
const annotationInput=parameters({id:text,asset:reference,name:text,note:text,kind:{type:'string',enum:['note','measurement','section']},points:{type:'array',items:point,minItems:1,maxItems:2}});
export const applicationDefinition: Pick<OntologyDocument,'objectTypes'|'interfaceTypes'|'linkTypes'|'functionTypes'|'actionTypes'|'dataSources'> = {
  objectTypes:[
    {apiName:'GeometryAsset',displayName:'三维模型',description:'An uploaded geometry model with its content identity and declared units.',primaryKey:'id',titleProperty:'name',interfaces:{},properties:properties({id:['Model identity',text],name:['Model name',text],format:['File format',assetInput.properties.format as Record<string,unknown>],contentHash:['SHA-256 of the uploaded model',text],byteLength:['Size in bytes',{type:'integer',minimum:1}],units:['Declared model coordinate units',text]})},
    {apiName:'GeometryAnnotation',displayName:'模型标注',description:'An annotation, measurement or section saved against a geometry model.',primaryKey:'id',titleProperty:'name',interfaces:{},properties:properties({id:['Annotation identity',text],name:['Annotation title',text],note:['Author note',text],kind:['Annotation kind',annotationInput.properties.kind as Record<string,unknown>],points:['Model-coordinate positions',{type:'array',items:point,minItems:1,maxItems:2}],distance:['Euclidean distance in the model coordinate units',{type:'number',minimum:0}],createdAt:['Creation time',{type:'string',format:'date-time'}]})},
  ],interfaceTypes:[],
  linkTypes:[{apiName:'GeometryAnnotationAsset',description:'The model described by an annotation.',from:{type:'GeometryAnnotation',name:'asset',cardinality:'one'},to:{type:'GeometryAsset',name:'annotations',cardinality:'many'}}],
  functionTypes:[{apiName:'registerGeometry',description:'Register a previously uploaded and verified model.',parameters:assetInput,returns:reference,edits:true},{apiName:'annotateGeometry',description:'Save a model note, measurement or section through an Action.',parameters:annotationInput,returns:reference,edits:true}],
  actionTypes:[{apiName:'RegisterGeometry',description:'Register an uploaded geometry asset.',parameters:assetInput,objectParameters:{},submissionCriteria:[],function:'registerGeometry'},{apiName:'AnnotateGeometry',description:'Save a model annotation.',parameters:annotationInput,objectParameters:{asset:'GeometryAsset'},submissionCriteria:[],function:'annotateGeometry'}],dataSources:[],
};
