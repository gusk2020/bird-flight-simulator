import { finish } from "./harness";
import { physicsTests } from "./sim";
import { cameraTests } from "./camera";
import { gameTests } from "./game";
import { envTests } from "./env";
physicsTests(); cameraTests(); gameTests(); envTests();
finish();
