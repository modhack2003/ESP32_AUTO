import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StatusBar,
  Animated,
  ActivityIndicator,
  Modal,
  Switch,
  Platform,
  KeyboardAvoidingView,
  PermissionsAndroid,
  LogBox,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

LogBox.ignoreLogs(['BLE PLX Native Module is not available']);
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

// Dynamically require BLE for native environments to prevent web build crashes
let BleManager;
if (Platform.OS !== 'web') {
  try {
    BleManager = require('react-native-ble-plx').BleManager;
  } catch (e) {
    console.log('BLE PLX not available in this environment');
  }
}

const STORAGE_KEY = '@esp32_ip_address';
const DEFAULT_IP = 'http://esp32auto.local';

// BLE UUIDs - MUST match the ESP32 firmware definitions
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHAR_CREDENTIALS_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const CHAR_STATUS_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';

// Pure JS Base64 utilities (avoiding native buffer issues)
const base64Encode = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let encoded = '';
  let i = 0;
  while (i < str.length) {
    const c1 = str.charCodeAt(i++);
    const c2 = i < str.length ? str.charCodeAt(i++) : NaN;
    const c3 = i < str.length ? str.charCodeAt(i++) : NaN;

    const byte1 = c1 >> 2;
    const byte2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
    const byte3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6);
    const byte4 = isNaN(c3) ? 64 : c3 & 63;

    encoded += chars.charAt(byte1) + chars.charAt(byte2) + chars.charAt(byte3) + chars.charAt(byte4);
  }
  return encoded;
};

const base64Decode = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let decoded = '';
  let i = 0;
  while (i < str.length) {
    const e1 = chars.indexOf(str.charAt(i++));
    const e2 = chars.indexOf(str.charAt(i++));
    const e3 = chars.indexOf(str.charAt(i++));
    const e4 = chars.indexOf(str.charAt(i++));

    const c1 = (e1 << 2) | (e2 >> 4);
    const c2 = ((e2 & 15) << 4) | (e3 >> 2);
    const c3 = ((e3 & 3) << 6) | e4;

    decoded += String.fromCharCode(c1);
    if (e3 !== 64 && e3 !== -1) decoded += String.fromCharCode(c2);
    if (e4 !== 64 && e4 !== -1) decoded += String.fromCharCode(c3);
  }
  return decoded;
};

export default function App() {
  const [esp32Ip, setEsp32Ip] = useState(DEFAULT_IP);
  const [ipInput, setIpInput] = useState(DEFAULT_IP);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connected' | 'connecting' | 'offline'
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [testResult, setTestResult] = useState({ type: '', message: '' });

  // BLE Provisioning States
  const [bleModalVisible, setBleModalVisible] = useState(false);
  const [bleStatus, setBleStatus] = useState('idle'); // 'idle' | 'scanning' | 'connecting' | 'form' | 'configuring' | 'success' | 'failed'
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [connectedDevice, setConnectedDevice] = useState(null);

  // 2 Switch states
  const [devices, setDevices] = useState({
    switch1: { name: 'Switch 1', state: false, pin: 16 },
    switch2: { name: 'Switch 2', state: false, pin: 17 },
  });

  // Animations
  const pulseAnim = useRef(new Animated.Value(0.6)).current;
  const radarAnim = useRef(new Animated.Value(0.5)).current;
  const bleManagerRef = useRef(null);

  // Load saved IP and names
  useEffect(() => {
    loadSettings();
    startPulseAnimation();
    
    // Initialize BLE manager on native platform
    if (BleManager) {
      try {
        bleManagerRef.current = new BleManager();
      } catch (e) {
        console.warn('BLE PLX Native Module is not available (e.g. running in Expo Go). BLE features will be disabled.', e);
        bleManagerRef.current = null;
      }
    }

    return () => {
      if (bleManagerRef.current) {
        bleManagerRef.current.destroy();
      }
    };
  }, []);

  // Polling loop
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      fetchStatus();
    }, 4000);
    return () => clearInterval(interval);
  }, [esp32Ip]);

  // Handle pulse for connection dot
  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.6,
          duration: 1200,
          useNativeDriver: true,
        }),
      ])
    ).start();
  };

  // Pulse animation for Bluetooth Radar scan
  useEffect(() => {
    if (bleStatus === 'scanning') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(radarAnim, {
            toValue: 1.2,
            duration: 1500,
            useNativeDriver: true,
          }),
          Animated.timing(radarAnim, {
            toValue: 0.5,
            duration: 0,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      radarAnim.setValue(0.5);
    }
  }, [bleStatus]);

  const loadSettings = async () => {
    try {
      const savedIp = await AsyncStorage.getItem(STORAGE_KEY);
      if (savedIp) {
        setEsp32Ip(savedIp);
        setIpInput(savedIp);
      }
      
      const savedName1 = await AsyncStorage.getItem('@switch1_name');
      const savedName2 = await AsyncStorage.getItem('@switch2_name');
      
      setDevices(prev => ({
        ...prev,
        switch1: { ...prev.switch1, name: savedName1 || 'Switch 1' },
        switch2: { ...prev.switch2, name: savedName2 || 'Switch 2' },
      }));
    } catch (e) {
      console.log('Failed to load settings');
    }
  };

  const saveSettings = async (newIp) => {
    try {
      let formattedIp = newIp.trim();
      if (!formattedIp.startsWith('http://') && !formattedIp.startsWith('https://')) {
        formattedIp = 'http://' + formattedIp;
      }
      if (formattedIp.endsWith('/')) {
        formattedIp = formattedIp.slice(0, -1);
      }
      await AsyncStorage.setItem(STORAGE_KEY, formattedIp);
      setEsp32Ip(formattedIp);
      setIpInput(formattedIp);
      setSettingsVisible(false);
      setConnectionStatus('connecting');
      setTestResult({ type: '', message: '' });
    } catch (e) {
      console.log('Failed to save IP settings');
    }
  };

  const updateSwitchName = async (key, newName) => {
    setDevices(prev => ({
      ...prev,
      [key]: { ...prev[key], name: newName }
    }));
    try {
      await AsyncStorage.setItem(`@${key}_name`, newName);
    } catch (e) {
      console.log(`Failed to save custom name for ${key}`);
    }
  };

  const fetchStatus = async () => {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${esp32Ip}/status`, { signal: controller.signal });
      clearTimeout(id);

      if (response.ok) {
        const data = await response.json();
        if (data.devices) {
          setDevices(prev => ({
            ...prev,
            switch1: { ...prev.switch1, state: !!data.devices.switch1?.state },
            switch2: { ...prev.switch2, state: !!data.devices.switch2?.state },
          }));
        }
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('offline');
      }
    } catch (error) {
      console.log(`[ESP32 Connection Offline] IP: ${esp32Ip}`);
      setConnectionStatus('offline');
    }
  };

  const toggleDevice = async (key) => {
    const device = devices[key];
    const newState = !device.state;

    const originalDevices = { ...devices };
    setDevices((prev) => ({
      ...prev,
      [key]: { ...prev[key], state: newState },
    }));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const response = await fetch(
        `${esp32Ip}/set?device=${key}&state=${newState ? 1 : 0}`,
        { signal: timeoutId.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Sync failed');
      }
      setConnectionStatus('connected');
    } catch (error) {
      console.log(`[Toggle Failed] Could not set state for ${key}`);
      setDevices(originalDevices);
      setConnectionStatus('offline');
    }
  };

  const triggerMasterSwitch = async (turnOn) => {
    setDevices((prev) => ({
      ...prev,
      switch1: { ...prev.switch1, state: turnOn },
      switch2: { ...prev.switch2, state: turnOn },
    }));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(
        `${esp32Ip}/master?state=${turnOn ? 1 : 0}`,
        { signal: timeoutId.signal }
      );
      clearTimeout(timeoutId);

      if (response.ok) {
        setConnectionStatus('connected');
      } else {
        throw new Error('Sync failed');
      }
    } catch (error) {
      console.log(`[Master Switch Failed]`);
      fetchStatus();
    }
  };

  const testConnection = async () => {
    setTestResult({ type: 'loading', message: 'Testing connection...' });
    let testIp = ipInput.trim();
    if (!testIp.startsWith('http://') && !testIp.startsWith('https://')) {
      testIp = 'http://' + testIp;
    }
    if (testIp.endsWith('/')) {
      testIp = testIp.slice(0, -1);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const response = await fetch(`${testIp}/status`, { signal: timeoutId.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        setTestResult({ type: 'success', message: 'Connected successfully!' });
      } else {
        setTestResult({
          type: 'error',
          message: `Status code: ${response.status}`,
        });
      }
    } catch (error) {
      setTestResult({
        type: 'error',
        message: 'Could not connect. Ensure ESP32 is powered and on same Wi-Fi.',
      });
    }
  };

  // ==========================================
  // BLE PROVISIONING BUSINESS LOGIC
  // ==========================================

  const requestAndroidPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);
        return (
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
        );
      } catch (err) {
        console.warn(err);
        return false;
      }
    }
    return true;
  };

  const startBleSetup = async () => {
    if (Platform.OS === 'web') {
      alert('Bluetooth setup is only supported on Android and iOS devices.');
      return;
    }

    setSettingsVisible(false);
    setBleModalVisible(true);
    setBleStatus('scanning');
    setDiscoveredDevices([]);

    const hasPermissions = await requestAndroidPermissions();
    if (!hasPermissions) {
      setBleStatus('failed');
      return;
    }

    const manager = bleManagerRef.current;
    if (!manager) {
      alert("Bluetooth module is not available in this environment. This typically happens when running the app in Expo Go (which does not support custom native modules like react-native-ble-plx).\n\nTo use Bluetooth setup, you must run the app in a development build ('npx expo run:android' or 'npx expo run:ios') or build a standalone app.");
      setBleStatus('failed');
      return;
    }

    // Start Scanning
    manager.startDeviceScan([SERVICE_UUID], null, (error, device) => {
      if (error) {
        console.log('Bluetooth Scan Error:', error);
        setBleStatus('failed');
        manager.stopDeviceScan();
        return;
      }

      if (device && device.name === 'NEXUS_Controller') {
        manager.stopDeviceScan();
        connectToBleDevice(device);
      }
    });

    // Timeout scan after 15 seconds
    setTimeout(() => {
      manager.stopDeviceScan();
      if (bleStatus === 'scanning' && !connectedDevice) {
        setBleStatus('failed');
      }
    }, 15000);
  };

  const connectToBleDevice = async (device) => {
    setBleStatus('connecting');
    try {
      const connected = await device.connect();
      const discovered = await connected.discoverAllServicesAndCharacteristics();
      setConnectedDevice(discovered);
      setBleStatus('form');
    } catch (e) {
      console.log('Failed to connect to BLE Device', e);
      setBleStatus('failed');
    }
  };

  const sendWifiCredentials = async () => {
    if (!wifiSsid) {
      alert('Please enter a Wi-Fi Name (SSID)');
      return;
    }

    if (!connectedDevice) {
      setBleStatus('failed');
      return;
    }

    setBleStatus('configuring');
    const device = connectedDevice;

    try {
      // Format: SSID\nPASSWORD
      const payload = `${wifiSsid}\n${wifiPass}`;
      const base64Payload = base64Encode(payload);

      // Write to credentials characteristic
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_CREDENTIALS_UUID,
        base64Payload
      );

      // Listen/Monitor status characteristic
      let monitorSubscription = device.monitorCharacteristicForService(
        SERVICE_UUID,
        CHAR_STATUS_UUID,
        (error, characteristic) => {
          if (error) {
            console.log('BLE Status Monitor Error', error);
            setBleStatus('failed');
            monitorSubscription?.remove();
            return;
          }

          if (characteristic && characteristic.value) {
            const rawStatus = base64Decode(characteristic.value);
            console.log('BLE Device Status Notification:', rawStatus);

            if (rawStatus === 'CONNECTING') {
              setBleStatus('configuring');
            } else if (rawStatus.startsWith('CONNECTED:')) {
              const ip = rawStatus.replace('CONNECTED:', '');
              setBleStatus('success');
              monitorSubscription?.remove();
              
              // Automatically configure and save settings
              saveSettings(ip);
              
              // Disconnect BLE
              device.cancelConnection().catch((err) => console.log('Clean disconnect BLE', err));
              setConnectedDevice(null);
            } else if (rawStatus === 'FAILED') {
              setBleStatus('failed');
              monitorSubscription?.remove();
              device.cancelConnection().catch((err) => console.log('BLE disconnect', err));
              setConnectedDevice(null);
            }
          }
        }
      );
    } catch (e) {
      console.log('BLE credential sending error', e);
      setBleStatus('failed');
    }
  };

  const cancelBleSetup = () => {
    if (bleManagerRef.current) {
      bleManagerRef.current.stopDeviceScan();
    }
    if (connectedDevice) {
      connectedDevice.cancelConnection().catch((err) => console.log('Clean disconnect', err));
    }
    setConnectedDevice(null);
    setBleStatus('idle');
    setBleModalVisible(false);
  };

  return (
    <SafeAreaProvider>
      <LinearGradient colors={['#110e2e', '#070514', '#020108']} style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" />
        
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.logoText}>NEXUS</Text>
              <Text style={styles.subLogoText}>2-CHANNEL AUTOMATION</Text>
            </View>

            {/* Connection Status badge */}
            <TouchableOpacity 
              style={styles.statusBadge} 
              onPress={() => {
                setIpInput(esp32Ip);
                setSettingsVisible(true);
              }}
            >
              <Animated.View
                style={[
                  styles.statusDot,
                  {
                    opacity: pulseAnim,
                    backgroundColor:
                      connectionStatus === 'connected'
                        ? '#10B981'
                        : connectionStatus === 'connecting'
                        ? '#F59E0B'
                        : '#EF4444',
                  },
                ]}
              />
              <Text style={styles.statusText}>
                {connectionStatus === 'connected'
                  ? 'ONLINE'
                  : connectionStatus === 'connecting'
                  ? 'CONNECTING'
                  : 'OFFLINE'}
              </Text>
              <Ionicons name="settings-outline" size={16} color="rgba(255,255,255,0.6)" style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            
            {/* Quick Actions Panel */}
            <View style={styles.quickActionsContainer}>
              <TouchableOpacity 
                style={[styles.quickButton, { backgroundColor: 'rgba(16, 185, 129, 0.12)', borderColor: 'rgba(16, 185, 129, 0.2)' }]}
                onPress={() => triggerMasterSwitch(true)}
              >
                <Ionicons name="power" size={18} color="#10B981" />
                <Text style={[styles.quickButtonText, { color: '#10B981' }]}>ALL ON</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.quickButton, { backgroundColor: 'rgba(239, 68, 68, 0.12)', borderColor: 'rgba(239, 68, 68, 0.2)' }]}
                onPress={() => triggerMasterSwitch(false)}
              >
                <Ionicons name="power-outline" size={18} color="#EF4444" />
                <Text style={[styles.quickButtonText, { color: '#EF4444' }]}>ALL OFF</Text>
              </TouchableOpacity>
            </View>

            {/* Switches Section */}
            <Text style={styles.sectionHeader}>RELAY CONTROLS (TAP NAMES TO EDIT)</Text>
            
            <View style={styles.switchesContainer}>
              
              {/* Channel 1 Switch */}
              <View style={[
                styles.applianceCard,
                devices.switch1.state && styles.cardActive1
              ]}>
                <View style={styles.cardMain}>
                  <TouchableOpacity
                    onPress={() => toggleDevice('switch1')}
                    style={[
                      styles.iconContainer, 
                      devices.switch1.state ? styles.iconActive1 : styles.iconInactive
                    ]}
                  >
                    <Ionicons 
                      name={devices.switch1.state ? "power" : "power-outline"} 
                      size={28} 
                      color={devices.switch1.state ? "#10B981" : "rgba(255,255,255,0.6)"} 
                    />
                  </TouchableOpacity>
                  
                  <View style={styles.labelContainer}>
                    <TextInput
                      style={styles.cardDeviceNameInput}
                      value={devices.switch1.name}
                      onChangeText={(val) => updateSwitchName('switch1', val)}
                      placeholder="Rename Switch 1..."
                      placeholderTextColor="rgba(255,255,255,0.2)"
                      maxLength={24}
                    />
                    <Text style={styles.cardDeviceRoom}>CHANNEL 1 (GPIO 16)</Text>
                  </View>
                </View>

                <Switch
                  value={devices.switch1.state}
                  onValueChange={() => toggleDevice('switch1')}
                  trackColor={{ false: '#2A2A35', true: '#10B981' }}
                  thumbColor={devices.switch1.state ? '#FFF' : '#A0A0B0'}
                />
              </View>

              {/* Channel 2 Switch */}
              <View style={[
                styles.applianceCard,
                devices.switch2.state && styles.cardActive2
              ]}>
                <View style={styles.cardMain}>
                  <TouchableOpacity
                    onPress={() => toggleDevice('switch2')}
                    style={[
                      styles.iconContainer, 
                      devices.switch2.state ? styles.iconActive2 : styles.iconInactive
                    ]}
                  >
                    <Ionicons 
                      name={devices.switch2.state ? "power" : "power-outline"} 
                      size={28} 
                      color={devices.switch2.state ? "#3B82F6" : "rgba(255,255,255,0.6)"} 
                    />
                  </TouchableOpacity>
                  
                  <View style={styles.labelContainer}>
                    <TextInput
                      style={styles.cardDeviceNameInput}
                      value={devices.switch2.name}
                      onChangeText={(val) => updateSwitchName('switch2', val)}
                      placeholder="Rename Switch 2..."
                      placeholderTextColor="rgba(255,255,255,0.2)"
                      maxLength={24}
                    />
                    <Text style={styles.cardDeviceRoom}>CHANNEL 2 (GPIO 17)</Text>
                  </View>
                </View>

                <Switch
                  value={devices.switch2.state}
                  onValueChange={() => toggleDevice('switch2')}
                  trackColor={{ false: '#2A2A35', true: '#3B82F6' }}
                  thumbColor={devices.switch2.state ? '#FFF' : '#A0A0B0'}
                />
              </View>

            </View>

            {/* Controller IP Settings Info Footer */}
            <TouchableOpacity 
              style={styles.settingsFooter} 
              onPress={() => {
                setIpInput(esp32Ip);
                setSettingsVisible(true);
              }}
            >
              <Ionicons name="link-outline" size={16} color="rgba(255,255,255,0.4)" />
              <Text style={styles.settingsFooterText}>
                ESP32 IP: {esp32Ip} (Tap to change)
              </Text>
            </TouchableOpacity>

          </ScrollView>
        </KeyboardAvoidingView>

        {/* IP Settings Modal */}
        <Modal
          animationType="fade"
          transparent={true}
          visible={settingsVisible}
          onRequestClose={() => setSettingsVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Controller Settings</Text>
                <TouchableOpacity onPress={() => setSettingsVisible(false)}>
                  <Ionicons name="close" size={24} color="#FFF" />
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>ESP32 IP / HOSTNAME</Text>
              <TextInput
                style={styles.textInput}
                value={ipInput}
                onChangeText={(text) => {
                  setIpInput(text);
                  setTestResult({ type: '', message: '' });
                }}
                placeholder="http://192.168.1.100"
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.helperText}>
                Use e.g., "http://192.168.1.100" or "http://esp32auto.local"
              </Text>

              {testResult.message !== '' && (
                <View style={[
                  styles.testMessageContainer,
                  testResult.type === 'success' && styles.testSuccess,
                  testResult.type === 'error' && styles.testError,
                  testResult.type === 'loading' && styles.testLoading
                ]}>
                  {testResult.type === 'loading' && <ActivityIndicator size="small" color="#F59E0B" style={{ marginRight: 6 }} />}
                  <Text style={[
                    styles.testMessageText,
                    testResult.type === 'success' && { color: '#10B981' },
                    testResult.type === 'error' && { color: '#EF4444' },
                    testResult.type === 'loading' && { color: '#F59E0B' }
                  ]}>
                    {testResult.message}
                  </Text>
                </View>
              )}

              {/* BLE Provisioning trigger */}
              {Platform.OS !== 'web' && (
                <TouchableOpacity style={styles.bleProvisionBtn} onPress={startBleSetup}>
                  <Ionicons name="bluetooth" size={16} color="#3B82F6" style={{ marginRight: 6 }} />
                  <Text style={styles.bleProvisionBtnText}>Setup Controller via Bluetooth</Text>
                </TouchableOpacity>
              )}

              <View style={styles.modalActionButtons}>
                <TouchableOpacity style={styles.testBtn} onPress={testConnection}>
                  <Text style={styles.testBtnText}>Test Link</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={() => saveSettings(ipInput)}>
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* BLE PROVISIONING MODAL */}
        <Modal
          animationType="slide"
          transparent={true}
          visible={bleModalVisible}
          onRequestClose={cancelBleSetup}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Bluetooth Provisioning</Text>
                <TouchableOpacity onPress={cancelBleSetup}>
                  <Ionicons name="close" size={24} color="#FFF" />
                </TouchableOpacity>
              </View>

              {/* Scanning status */}
              {bleStatus === 'scanning' && (
                <View style={styles.bleStatusWrapper}>
                  <Animated.View style={[
                    styles.bleRadarRing,
                    { transform: [{ scale: radarAnim }] }
                  ]} />
                  <Ionicons name="bluetooth" size={54} color="#3B82F6" />
                  <Text style={styles.bleStatusMainText}>Searching for Controller...</Text>
                  <Text style={styles.bleStatusSubText}>Ensure the ESP32 is powered on and in pairing range.</Text>
                  <ActivityIndicator size="small" color="#FFF" style={{ marginTop: 15 }} />
                </View>
              )}

              {/* Connecting status */}
              {bleStatus === 'connecting' && (
                <View style={styles.bleStatusWrapper}>
                  <Ionicons name="sync-outline" size={54} color="#F59E0B" />
                  <Text style={styles.bleStatusMainText}>Connecting to ESP32...</Text>
                  <Text style={styles.bleStatusSubText}>Establishing secure Bluetooth connection...</Text>
                  <ActivityIndicator size="small" color="#F59E0B" style={{ marginTop: 15 }} />
                </View>
              )}

              {/* Credentials input form */}
              {bleStatus === 'form' && (
                <View style={{ width: '100%' }}>
                  <Text style={styles.bleStatusMainText}>Configure Wi-Fi Connection</Text>
                  <Text style={styles.bleStatusSubText}>Provide your local Wi-Fi router information for the ESP32.</Text>

                  <Text style={styles.inputLabel}>WI-FI NAME (SSID)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={wifiSsid}
                    onChangeText={setWifiSsid}
                    placeholder="SSID name"
                    placeholderTextColor="rgba(255,255,255,0.3)"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <Text style={styles.inputLabel}>WI-FI PASSWORD</Text>
                  <TextInput
                    style={styles.textInput}
                    value={wifiPass}
                    onChangeText={setWifiPass}
                    placeholder="WPA2 Password"
                    placeholderTextColor="rgba(255,255,255,0.3)"
                    secureTextEntry={true}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <TouchableOpacity style={styles.fullSaveBtn} onPress={sendWifiCredentials}>
                    <Text style={styles.saveBtnText}>Connect Controller to Wi-Fi</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Configuring (ESP32 attempting connection) */}
              {bleStatus === 'configuring' && (
                <View style={styles.bleStatusWrapper}>
                  <Ionicons name="wifi-outline" size={54} color="#3B82F6" />
                  <Text style={styles.bleStatusMainText}>Connecting ESP32 to Router...</Text>
                  <Text style={styles.bleStatusSubText}>The controller is currently connecting to your local Wi-Fi router. Please wait.</Text>
                  <ActivityIndicator size="large" color="#3B82F6" style={{ marginTop: 15 }} />
                </View>
              )}

              {/* Success */}
              {bleStatus === 'success' && (
                <View style={styles.bleStatusWrapper}>
                  <Ionicons name="checkmark-circle" size={64} color="#10B981" />
                  <Text style={styles.bleStatusMainText}>Setup Successful!</Text>
                  <Text style={styles.bleStatusSubText}>Your controller has connected to Wi-Fi, and the IP has been configured in the app.</Text>
                  <TouchableOpacity style={styles.doneBtn} onPress={cancelBleSetup}>
                    <Text style={styles.doneBtnText}>Return to Dashboard</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Failed */}
              {bleStatus === 'failed' && (
                <View style={styles.bleStatusWrapper}>
                  <Ionicons name="alert-circle" size={64} color="#EF4444" />
                  <Text style={styles.bleStatusMainText}>Setup Failed</Text>
                  <Text style={styles.bleStatusSubText}>Unable to discover or connect your device. Make sure bluetooth is enabled, and Wi-Fi password is correct.</Text>
                  <TouchableOpacity style={styles.retryBtn} onPress={startBleSetup}>
                    <Text style={styles.retryBtnText}>Retry Scanning</Text>
                  </TouchableOpacity>
                </View>
              )}

            </View>
          </View>
        </Modal>

      </SafeAreaView>
    </LinearGradient>
   </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'android' ? 40 : 15,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  logoText: {
    fontSize: 22,
    fontWeight: '900',
    color: '#FFF',
    letterSpacing: 2,
  },
  subLogoText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#3B82F6',
    letterSpacing: 1.5,
    marginTop: -2,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#FFF',
    letterSpacing: 0.5,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 40,
  },
  quickActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 30,
  },
  quickButton: {
    flex: 0.48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  quickButtonText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginLeft: 6,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: 'bold',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1.5,
    marginBottom: 15,
  },
  switchesContainer: {
    gap: 16,
  },
  applianceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 22,
    padding: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: {
        elevation: 5,
      },
    }),
  },
  cardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  labelContainer: {
    flex: 1,
  },
  cardActive1: {
    backgroundColor: 'rgba(16, 185, 129, 0.07)',
    borderColor: 'rgba(16, 185, 129, 0.25)',
  },
  cardActive2: {
    backgroundColor: 'rgba(59, 130, 246, 0.07)',
    borderColor: 'rgba(59, 130, 246, 0.25)',
  },
  iconContainer: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  iconInactive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  iconActive1: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
  },
  iconActive2: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
  },
  cardDeviceNameInput: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFF',
    paddingVertical: 2,
    borderBottomWidth: 1,
    borderBottomColor: 'transparent',
  },
  cardDeviceRoom: {
    fontSize: 9,
    fontWeight: 'bold',
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 1,
    marginTop: 2,
  },
  settingsFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 35,
    paddingVertical: 12,
  },
  settingsFooterText: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    marginLeft: 6,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: '#161426',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFF',
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 1,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    color: '#FFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 14,
    marginBottom: 16,
  },
  helperText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    marginBottom: 20,
  },
  testMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 15,
  },
  testSuccess: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
  },
  testError: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  testLoading: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
  },
  testMessageText: {
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
  },
  modalActionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  testBtn: {
    flex: 0.47,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  testBtnText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  saveBtn: {
    flex: 0.47,
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  bleProvisionBtn: {
    flexDirection: 'row',
    backgroundColor: 'rgba(59, 130, 246, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.2)',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  bleProvisionBtnText: {
    color: '#3B82F6',
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: 0.5,
  },
  bleStatusWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 30,
    width: '100%',
  },
  bleStatusMainText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 20,
    textAlign: 'center',
  },
  bleStatusSubText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 10,
  },
  bleRadarRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    opacity: 0.4,
  },
  fullSaveBtn: {
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
    width: '100%',
  },
  doneBtn: {
    backgroundColor: '#10B981',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 20,
  },
  doneBtnText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  retryBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 20,
  },
  retryBtnText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
});
