import { Container, getContainer } from "@cloudflare/containers";

export class FlayBuildContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true;
}

export default {
  async fetch(request, env) {
    return getContainer(env.FLay_BUILD_SERVER, "flaynity-build-server").fetch(request);
  }
};
