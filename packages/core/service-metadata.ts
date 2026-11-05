/** Public foundation discovery only; it issues no task or business authority. */
export function taskScopedServices(){
  return [{id:'eigos.delegate',name:'Task-scoped EIGOS execution',description:'Delegate within the current installation and task grants. Resources, source operations, model processing and delivery channels require independent permission.',requiredInputs:['goal'],tags:['delegation'],examples:[],inputModes:['text/plain','application/json'],outputModes:['application/json','text/markdown']}];
}
