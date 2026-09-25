// Point d'entrée : les tâches d'arrière-plan (TaskManager.defineTask) et le gestionnaire de
// notifications sont enregistrés AVANT le routeur, y compris lors d'une relance sans interface.
import "./src/lib/location";
import "./src/lib/notifications";
import "expo-router/entry";
