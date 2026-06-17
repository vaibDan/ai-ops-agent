import {
    restartDeployment,
    scaleDeployment,
    rollbackDeployment,
} from "../agent/src/services/kubernetes";

async function main() {
    try {
        // console.log(await restartDeployment("sample-app"));

        // console.log(await scaleDeployment("sample-app", 3));

        // Uncomment if you want to test rollback
        console.log(await rollbackDeployment("sample-app", "nginx:latest"));

    } catch (err) {
        console.error("Test failed:", err);
    }
}

main();