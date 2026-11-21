const cases={
  full_time:"normal", first_half:"firstHalf", missing_data:"missingData", insufficient:"insufficient"
};

export function createOfflineAnalysisFixtureClient(examples, archiveExample) {
  return {
    async getArchive() {
      return {status:200, body:structuredClone(archiveExample)};
    },
    async getAnalysis(scenario) {
      if(scenario==="api_error")return structuredClone(examples.apiError);
      if(!Object.hasOwn(cases,scenario))throw new RangeError("Unknown offline scenario: "+scenario);
      return {status:200, body:structuredClone(examples[cases[scenario]])};
    }
  };
}
