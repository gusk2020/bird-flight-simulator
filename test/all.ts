import { finish } from "./harness";
import { physicsTests } from "./physics";
import { cameraTests } from "./camera";
import { gameTests } from "./game";
import { envTests } from "./env";
import { stageBTests } from "./stageb";
physicsTests(); cameraTests(); gameTests(); envTests(); stageBTests();
finish();
