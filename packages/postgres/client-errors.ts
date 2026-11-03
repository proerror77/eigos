interface PostgresErrorEvents {
  on(event:'error',listener:(error:Error)=>void):unknown;
  removeListener(event:'error',listener:(error:Error)=>void):unknown;
}

/** pg emits client.error even when a pending query also rejects. The lease
 * owner must observe that event, retain its first cause and discard the client.
 * This observer never retries a command or changes commit acknowledgement. */
export function observePostgresClient(client:PostgresErrorEvents){
  let first:Error|undefined,closed=false;
  const record=(error:unknown)=>{first??=error instanceof Error?error:new Error('PostgreSQL connection failed');};
  client.on('error',record);
  return {
    get failure(){return first;},
    check(){if(first)throw first;},
    annotate(error:unknown):unknown{
      if(!first||error===first||error instanceof Error&&error.cause===first)return error;
      if(error instanceof Error&&Object.isExtensible(error)){
        // Preserve the exact transaction wrapper, timeout or security error,
        // including an existing COMMIT-unknown classification and first cause.
        const property=error.cause===undefined&&!Object.hasOwn(error,'cause')?'cause':'postgresConnectionCause';
        if(!Object.hasOwn(error,property))Object.defineProperty(error,property,{value:first,configurable:true});
        return error;
      }
      return new Error('PostgreSQL operation failed after connection loss',{cause:first});
    },
    close(){if(!closed){closed=true;client.removeListener('error',record);}},
  };
}
